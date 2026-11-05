import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const workflow = readFileSync(new URL('../.github/workflows/publish-mcp.yml', import.meta.url), 'utf8');
const testWorkflow = readFileSync(new URL('../.github/workflows/test.yml', import.meta.url), 'utf8');
// One top-level job, up to the next job key.
function jobSource(source, name) {
  const start = source.indexOf(`\n  ${name}:\n`);
  assert.ok(start >= 0, `job ${name} is missing`);
  const rest = source.slice(start + 1);
  const end = rest.search(/\n  [a-z][a-z-]*:\n/);
  return end < 0 ? rest : rest.slice(0, end + 1);
}

test('MCP publication waits for successful main Tests', () => {
  assert.match(workflow, /workflow_run:\s*\n\s+workflows:\s*\n\s+- Tests/);
  assert.doesNotMatch(workflow, /\n\s+push:\s*\n/);
  assert.match(workflow, /workflow_run\.conclusion == 'success'/);
  assert.match(workflow, /workflow_run\.event == 'push'/);
  assert.match(workflow, /workflow_run\.head_branch == 'main'/);
  assert.match(workflow, /workflow_run\.head_repository\.full_name == github\.repository/);
  assert.match(workflow, /workflow_run\.head_sha/);
});

test('main Tests run the repository release-candidate check with complete history', () => {
  assert.match(testWorkflow, /fetch-depth: 0/);
  assert.match(testWorkflow, /name: Validate release candidate[\s\S]*node scripts\/oss-release-check\.mjs/);
});

test('documentation-only skips are bound to the conservative source plan and still seal the docs artifact', () => {
  assert.match(testWorkflow, /run: node scripts\/source-check-plan.mjs/);
  assert.match(testWorkflow, /Validate documentation candidate[\s\S]*npm run release:plan[\s\S]*npm run security:audit[\s\S]*--docs-only --release-artifacts/);
  for (const name of ['dependencies', 'e2e-shard']) {
    assert.match(jobSource(testWorkflow, name), /needs: plan\n    if: needs.plan.outputs.lane != 'docs'/);
  }
});

test('the required Playwright e2e check passes only when every shard passed or the lane skipped them', () => {
  const shards = jobSource(testWorkflow, 'e2e-shard');
  assert.match(shards, /fail-fast: false/);
  assert.match(shards, /shard: \[1, 2, 3, 4\]/);
  assert.match(shards, /--shard=\$\{\{ matrix\.shard \}\}\/4/);
  const check = jobSource(testWorkflow, 'e2e');
  assert.match(check, /name: Playwright e2e\n/);
  assert.match(check, /needs: \[plan, e2e-shard\]\n    if: always\(\)/);
  assert.match(check, /\[ "\$PLAN" = success \] && \{ \[ "\$SHARDS" = success \] \|\| \[ "\$SHARDS" = skipped \]; \}/);
});

test('the required release candidate check joins the candidate build and its parallel source tests', () => {
  assert.match(jobSource(testWorkflow, 'unit'), /oss-release-check\.mjs --release-artifacts --skip-tests/);
  const tests = jobSource(testWorkflow, 'source-tests');
  assert.match(tests, /needs: plan\n    if: needs.plan.outputs.lane != 'docs' && needs.plan.outputs.lane != 'reuse'/);
  assert.match(tests, /suite: \[infra, workspaces\]/);
  assert.match(tests, /npm run test:infra/);
  assert.match(tests, /npm run test --workspaces --if-present/);
  const check = jobSource(testWorkflow, 'candidate');
  assert.match(check, /name: Release candidate check\n/);
  assert.match(check, /needs: \[plan, unit, source-tests\]\n    if: always\(\)/);
  assert.match(check, /\[ "\$BUILD" = success \]/);
});

test('main reuses only a recorded pull request qualification and still probes dependencies and seals docs', () => {
  const job = name => jobSource(testWorkflow, name);
  // Unknown or missing lanes fall back to the complete gate.
  assert.match(job('unit'), /Validate release candidate\n        if: needs.plan.outputs.lane != 'docs' && needs.plan.outputs.lane != 'reuse'/);
  assert.match(job('unit'), /Validate documentation candidate\n        if: needs.plan.outputs.lane == 'docs' \|\| needs.plan.outputs.lane == 'reuse'/);
  assert.match(job('e2e-shard'), /if: needs.plan.outputs.lane != 'docs' && needs.plan.outputs.lane != 'reuse'/);
  assert.match(job('dependencies'), /if: needs.plan.outputs.lane != 'docs'\n/);
  assert.match(job('unit'), /name: docs-\$\{\{ github\.sha \}\}/);
  // Only same-repository full-lane pull request runs record a tree, and never fail on it.
  const plan = job('plan');
  assert.match(plan, /fetch-depth: 0/);
  assert.match(plan, /github\.event_name == 'pull_request' &&\s+steps\.plan\.outputs\.lane == 'full' &&\s+github\.event\.pull_request\.head\.repo\.full_name == github\.repository/);
  assert.match(plan, /source-check-plan\.mjs record temp\/pr-qualification/);
  assert.match(plan, /name: \$\{\{ steps\.record\.outputs\.name \}\}/);
  assert.equal(plan.match(/continue-on-error: true/g)?.length, 2);
});

test('the OSS release train is serialized and uses pinned Trusted Publishing tooling', () => {
  assert.match(workflow, /concurrency:\s*\n\s+group: release-oss\s*\n\s+cancel-in-progress: false/);
  assert.match(workflow, /id-token: write/);
  assert.match(workflow, /npm install --global npm@11\.6\.2/);
  assert.match(workflow, /npm publish --access public --provenance/);
  assert.match(workflow, /Validate manual publication confirmation[\s\S]*test "\$CONFIRM_RELEASE" = 'RELEASE_TYPEROLL_OSS'/);
});

test('MCP publication verifies npm before creating the release tag', () => {
  const publish = workflow.indexOf('- name: Publish MCP through npm OIDC');
  const verify = workflow.indexOf('- name: Verify MCP release');
  const tag = workflow.indexOf('- name: Create verified MCP tag');

  assert.ok(publish >= 0, 'publish step is missing');
  assert.ok(verify > publish, 'npm verification must follow publication');
  assert.ok(tag > verify, 'release tag must follow npm verification');
  assert.match(workflow, /dry_run:[\s\S]*?default: true/);
  assert.match(workflow, /PUBLISHED_SHA.*!=.*SOURCE_SHA/);
});

test('the release train publishes Core, MCP and docs in parallel before the manifest', () => {
  const core = workflow.indexOf('\n  core:');
  const mcp = workflow.indexOf('\n  mcp:');
  const docs = workflow.indexOf('\n  docs:');
  const manifest = workflow.indexOf('\n  manifest:');
  assert.ok(core > 0 && mcp > core && docs > mcp && manifest > docs);
  assert.match(workflow, /mcp:[\s\S]*needs: plan/);
  assert.match(workflow, /docs:[\s\S]*needs: plan/);
  assert.match(workflow, /manifest:[\s\S]*needs: \[plan, core, mcp, docs\]/);
  assert.match(workflow, /RELEASE_TYPEROLL_OSS/);
});

test('publication trusts the exact successful release-candidate source gate', () => {
  assert.doesNotMatch(workflow, /- name: Verify Core source/);
  assert.doesNotMatch(workflow, /npm run typecheck --workspace=@typeroll\/mcp-server/);
  assert.doesNotMatch(workflow, /npm test --workspace=@typeroll\/mcp-server/);
  assert.match(workflow, /Build and inspect MCP package[\s\S]*npm run build --workspace=@typeroll\/mcp-server/);
  assert.match(workflow, /Verify the bundle serves its release identity/);
});

test('docs reuse requires exact successful source proof before any publication', () => {
  assert.match(workflow, /qualified-docs\.mjs/);
  assert.match(workflow, /Verify qualified documentation before publication[\s\S]*release-artifact\.mjs verify/);
  assert.match(workflow, /run-id: \$\{\{ needs\.plan\.outputs\.tests_run_id \}\}/);
  assert.doesNotMatch(workflow, /--docs-only|prepare:migration|build:docs/);
  assert.match(testWorkflow, /--release-artifacts/);
  assert.match(testWorkflow, /name: docs-\$\{\{ github\.sha \}\}/);
  assert.doesNotMatch(testWorkflow, /needs: unit/);
  assert.match(testWorkflow, /release-dependencies\.mjs/);
});

test('an interrupted Core publication reuses the published bundle and never rebuilds over it', () => {
  const core = jobSource(workflow, 'core');
  const steps = ['Verify Core release version', 'Inspect published Worker bundle', 'Install build dependencies', 'Build the Worker bundle',
    'Verify the Worker bundle and its release contract', 'Verify the bundle serves its release identity', 'Attest Worker bundle build provenance',
    'Verify Worker bundle provenance', 'Create verified Core tag', 'Publish the Worker bundle on the Core release']
    .map(name => core.indexOf(`- name: ${name}\n`));
  assert.ok(steps.every((index, position) => index > 0 && (position === 0 || index > steps[position - 1])), String(steps));
  // The bundle is built from the commit the Core tag names.
  assert.match(core, /ref: \$\{\{ needs\.plan\.outputs\.core_source_sha \}\}/);
  for (const step of ['Install build dependencies', 'Build the Worker bundle', 'Verify the bundle serves its release identity']) {
    assert.match(core, new RegExp(`${step}\\n        if: steps\\.published\\.outputs\\.exists != 'true'\\n`));
  }
  // A release in an unknown state stops the run instead of publishing again.
  assert.match(core, /Could not safely determine whether release \$CORE_TAG exists/);
  assert.match(core, /carries only one of \$TARBALL and \$DESCRIPTOR/);
  // Every bundle, reused or new, is verified against the exact Core source.
  assert.match(core, /release-worker-bundle\.mjs verify --dir temp\/core-workers --source-sha "\$CORE_SOURCE_SHA" --core-tag "\$CORE_TAG"/);
  assert.match(core, /test "\$\(jq -r '\.bundle_digest' <<<"\$RELEASE"\)" = "\$BUNDLE_DIGEST"/);
  // The published asset must be the verified bytes.
  assert.match(core, /test "sha256:\$\(sha256sum "\$CHECK\/\$TARBALL" \| cut -d' ' -f1\)" = "\$BUNDLE_DIGEST"/);
  assert.doesNotMatch(core, /--clobber|gh release delete/);
});

test('Core provenance is attested before the tag and verified exactly as Cloud verifies it', () => {
  const core = jobSource(workflow, 'core');
  assert.match(core, /Attest Worker bundle build provenance\n        if: steps\.published\.outputs\.exists != 'true' && env\.PUBLISH == 'true'\n        uses: actions\/attest-build-provenance@[a-f0-9]{40}/);
  assert.match(core, /subject-path: temp\/core-workers\/\$\{\{ steps\.bundle\.outputs\.tarball \}\}/);
  assert.match(core, /gh attestation verify "temp\/core-workers\/\$TARBALL"\n\s+--repo "\$GITHUB_REPOSITORY"\n\s+--signer-workflow "\$GITHUB_REPOSITORY\/\.github\/workflows\/publish-mcp\.yml"\n\s+--source-ref refs\/heads\/main\n\s+--predicate-type https:\/\/slsa\.dev\/provenance\/v1\n\s+--deny-self-hosted-runners/);
  assert.match(core, /PUBLISH: \$\{\{ github\.event_name != 'workflow_dispatch' \|\| inputs\.dry_run != true \}\}/);
  assert.match(core, /Create verified Core tag\n        if: needs\.plan\.outputs\.publish_core == 'true' && env\.PUBLISH == 'true'/);
  // No container image is published any more.
  assert.doesNotMatch(workflow, /ghcr\.io|crane|docker\/|core-image/);
  assert.match(jobSource(workflow, 'manifest'), /--bundle "temp\/core-workers\/typeroll-core-\$\{\{ needs\.plan\.outputs\.core_version \}\}-workers\.json"/);
  assert.match(core, /name: core-workers-\$\{\{ needs\.plan\.outputs\.source_sha \}\}/);
});

test('documentation publication verifies its source without redeploying the retired host', () => {
  const deploy = workflow.indexOf('- name: Publish static documentation at typeroll.com/docs');
  const verify = workflow.indexOf('- name: Verify published documentation');
  assert.ok(deploy > 0 && verify > deploy);
  assert.match(workflow.slice(verify), /verify-live-docs\.mjs --source-sha/);
  assert.doesNotMatch(workflow, /pages deploy|old-docs-host|--redirects/);
});

test('unchanged packages do not reinstall build dependencies during publication', () => {
  const core = jobSource(workflow, 'core');
  assert.match(core, /Install build dependencies\n        if: steps\.published\.outputs\.exists != 'true'\n        run: npm ci/);
  assert.match(workflow, /Install MCP build dependencies\n        if: needs\.plan\.outputs\.publish_mcp == 'true'/);
});

test('main Tests no longer prebuild or push a Core container image', () => {
  assert.doesNotMatch(testWorkflow, /\n  image:|packages: write|core-image|Plan Core publication/);
  assert.match(testWorkflow, /^permissions:\n  contents: read\n  actions: read\n\njobs:/m);
});

test('the release train has no default token grant and each job requests only its own permissions', () => {
  assert.match(workflow, /^permissions: \{\}\n/m);
  const permissions = name => {
    const block = jobSource(workflow, name).match(/\n    permissions:\n((?:      [a-z-]+: (?:read|write)\n)+)/);
    assert.ok(block, `job ${name} must declare permissions`);
    return Object.fromEntries(block[1].trim().split('\n').map(line => line.trim().split(': ')));
  };
  assert.deepEqual(permissions('plan'), { contents: 'read', actions: 'read' });
  assert.deepEqual(permissions('core'), { contents: 'write', 'id-token': 'write', attestations: 'write', actions: 'read' });
  assert.deepEqual(permissions('mcp'), { contents: 'write', 'id-token': 'write' });
  assert.deepEqual(permissions('registry'), { contents: 'read', 'id-token': 'write' });
  assert.deepEqual(permissions('docs'), { contents: 'read', actions: 'read' });
  assert.deepEqual(permissions('manifest'), { contents: 'read' });
  // OIDC only for the Core bundle provenance, npm Trusted Publishing and the
  // MCP Registry namespace proof; only Core writes attestations.
  assert.equal(workflow.match(/id-token: write/g).length, 3);
  assert.equal(workflow.match(/attestations: write/g).length, 1);
});

test('every external action is pinned to a full commit SHA', () => {
  for (const source of [workflow, testWorkflow]) {
    for (const [, reference] of source.matchAll(/uses: ([^\s]+)/g)) {
      if (reference.startsWith('./')) continue;
      assert.match(reference, /^[\w.-]+\/[\w.-]+@[a-f0-9]{40}$/, reference);
    }
  }
});

test('documentation deploys with the locked uploader dependencies and no install scripts', () => {
  const docs = jobSource(workflow, 'docs');
  assert.doesNotMatch(workflow, /npx wrangler/);
  assert.match(docs, /cp packages\/portal\/src\/lib\/builds\/uploader-lock\.json "\$DEPLOYER\/package-lock\.json"/);
  assert.match(docs, /npm ci --prefix "\$DEPLOYER" --ignore-scripts/);
  assert.match(docs, /"\$WRANGLER" deploy --config packages\/docs-site\/wrangler\.jsonc/);
});

test('the MCP Registry listing follows npm, uses a verified pinned publisher and is idempotent', () => {
  const job = jobSource(workflow, 'registry');
  assert.match(job, /continue-on-error: true/);
  assert.match(job, /needs: \[plan, mcp\]/);
  assert.match(job, /needs\.plan\.outputs\.publish_mcp == 'true'/);
  assert.match(job, /inputs\.dry_run != true/);
  assert.match(job, /MCP_PUBLISHER_VERSION: v\d+\.\d+\.\d+\n/);
  assert.doesNotMatch(job, /releases\/latest/);
  assert.match(job, /cosign verify-blob/);
  assert.match(job, /--certificate-identity "https:\/\/github\.com\/modelcontextprotocol\/registry\/\.github\/workflows\/release\.yml@refs\/tags\/\$\{MCP_PUBLISHER_VERSION\}"/);
  assert.match(job, /test "\$NAME" = "\$\(jq -r \.mcpName package\.json\)"/);
  assert.match(job, /versions\/\$MCP_VERSION/);
  assert.match(job, /mcp-publisher" login github-oidc/);
  assert.ok(job.indexOf('listed=true') < job.indexOf('mcp-publisher" publish'));
});
