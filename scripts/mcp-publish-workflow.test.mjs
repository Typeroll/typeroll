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
  for (const name of ['dependencies', 'e2e']) {
    const job = testWorkflow.slice(testWorkflow.indexOf(`\n  ${name}:`));
    assert.match(job, /needs: plan\n    if: needs.plan.outputs.lane != 'docs'/);
  }
});

test('main reuses only a recorded pull request qualification and still probes dependencies and seals docs', () => {
  const job = name => jobSource(testWorkflow, name);
  // Unknown or missing lanes fall back to the complete gate.
  assert.match(job('unit'), /Validate release candidate\n        if: needs.plan.outputs.lane != 'docs' && needs.plan.outputs.lane != 'reuse'/);
  assert.match(job('unit'), /Validate documentation candidate\n        if: needs.plan.outputs.lane == 'docs' \|\| needs.plan.outputs.lane == 'reuse'/);
  assert.match(job('e2e'), /if: needs.plan.outputs.lane != 'docs' && needs.plan.outputs.lane != 'reuse'/);
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
  assert.match(workflow, /Verify published image contract/);
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

test('an interrupted Core publication can recover only from the same source commit', () => {
  const inspect = workflow.indexOf('- name: Inspect existing Core release');
  const build = workflow.indexOf('- name: Build and publish immutable image');
  const verify = workflow.indexOf('- name: Verify published image contract');
  const tag = workflow.indexOf('- name: Create verified Core tag');

  assert.ok(inspect > 0 && inspect < build);
  assert.ok(build < verify && verify < tag);
  assert.match(workflow, /org\.opencontainers\.image\.revision/);
  assert.match(workflow, /REVISION.*!=.*SOURCE_SHA/);
  assert.match(workflow, /steps\.registry\.outputs\.exists != 'true'/);
  assert.match(workflow, /EXISTING_DIGEST: \$\{\{ steps\.registry\.outputs\.image_digest \}\}/);
});

test('a prebuilt Core image is reused only for the exact source and release, after the same contract check', () => {
  const core = jobSource(workflow, 'core');
  const steps = ['Inspect existing Core release', 'Inspect prebuilt Core image', 'Build and publish immutable image',
    'Resolve release digest', 'Verify published image contract', 'Tag verified prebuilt image', 'Create verified Core tag']
    .map(name => core.indexOf(`- name: ${name}\n`));
  assert.ok(steps.every((index, position) => index > 0 && (position === 0 || index > steps[position - 1])), String(steps));
  assert.match(core, /Inspect prebuilt Core image\n        id: prebuilt\n        if: needs\.plan\.outputs\.publish_core == 'true' && steps\.registry\.outputs\.exists != 'true'/);
  assert.match(core, /IMAGE="ghcr\.io\/typeroll\/typeroll:sha-\$SOURCE_SHA"/);
  assert.match(core, /if \[ "\$REVISION" = "\$SOURCE_SHA" \] && \[ "\$VERSION" = "\$CORE_TAG" \]; then/);
  assert.match(core, /steps\.registry\.outputs\.exists != 'true' &&\s+steps\.prebuilt\.outputs\.exists != 'true'\n\s+uses: \.\/\.github\/actions\/core-image/);
  assert.match(core, /PREBUILT_DIGEST: \$\{\{ steps\.prebuilt\.outputs\.image_digest \}\}/);
  assert.match(core, /crane tag "ghcr\.io\/typeroll\/typeroll@\$IMAGE_DIGEST" "\$CORE_TAG"/);
  assert.match(jobSource(workflow, 'manifest'), /--image-digest "\$\{\{ needs\.core\.outputs\.image_digest \}\}"/);
});

test('documentation publication verifies its source without redeploying the retired host', () => {
  const deploy = workflow.indexOf('- name: Publish static documentation at typeroll.com/docs');
  const verify = workflow.indexOf('- name: Verify published documentation');
  assert.ok(deploy > 0 && verify > deploy);
  assert.match(workflow.slice(verify), /verify-live-docs\.mjs --source-sha/);
  assert.doesNotMatch(workflow, /pages deploy|old-docs-host|--redirects/);
});

test('unchanged packages do not reinstall build dependencies during publication', () => {
  const core = workflow.slice(workflow.indexOf('\n  core:'), workflow.indexOf('\n  mcp:'));
  assert.doesNotMatch(core, /run: npm ci/);
  assert.match(workflow, /Install MCP build dependencies\n        if: needs\.plan\.outputs\.publish_mcp == 'true'/);
});

test('main Tests prebuild only the sha- image of a planned Core release, with the only write grant', () => {
  const image = jobSource(testWorkflow, 'image');
  assert.match(image, /needs: plan\n/);
  assert.match(image, /github\.event_name == 'push' &&\s+github\.ref == 'refs\/heads\/main' &&\s+github\.repository == 'Typeroll\/typeroll' &&\s+needs\.plan\.outputs\.publish_core == 'true'/);
  assert.match(image, /permissions:\n      contents: read\n      packages: write\n/);
  assert.match(image, /source_sha: \$\{\{ github\.sha \}\}\n\s+core_tag: \$\{\{ needs\.plan\.outputs\.core_tag \}\}\n\s+tags: ghcr\.io\/typeroll\/typeroll:sha-\$\{\{ github\.sha \}\}\n/);
  assert.doesNotMatch(image, /core-v|git tag|crane/);
  // The workflow default stays read-only; no other job can write packages.
  assert.match(testWorkflow, /^permissions:\n  contents: read\n  actions: read\n\njobs:/m);
  assert.equal(testWorkflow.match(/packages: write/g).length, 1);
  assert.match(jobSource(testWorkflow, 'plan'), /Plan Core publication\n        id: release\n        if: github\.event_name == 'push'\n        run: node scripts\/oss-release-plan\.mjs --github-output/);
});

test('every Core image build uses the one shared build definition', () => {
  const action = readFileSync(new URL('../.github/actions/core-image/action.yml', import.meta.url), 'utf8');
  for (const source of [workflow, testWorkflow]) {
    assert.doesNotMatch(source, /docker\/build-push-action|docker\/setup-buildx-action/);
  }
  assert.match(workflow, /uses: \.\/\.github\/actions\/core-image/);
  assert.match(testWorkflow, /uses: \.\/\.github\/actions\/core-image/);
  assert.match(action, /using: composite/);
  assert.match(action, /org\.opencontainers\.image\.revision=\$\{\{ inputs\.source_sha \}\}/);
  assert.match(action, /org\.opencontainers\.image\.version=\$\{\{ inputs\.core_tag \}\}/);
  assert.match(action, /TYPEROLL_SOURCE_SHA=\$\{\{ inputs\.source_sha \}\}/);
  assert.match(action, /platforms: linux\/amd64\n\s+cache-from: type=gha,scope=core\n\s+cache-to: type=gha,scope=core,mode=max\n\s+sbom: true\n\s+provenance: mode=max/);
});
