import assert from 'node:assert/strict';
import test from 'node:test';

import { readFileSync } from 'node:fs';
import { buildReleaseManifest, buildReleasePlan, releaseScopes } from './oss-release-plan.mjs';

// The bundle fixture follows the current Core version, which release:bump rewrites.
const CORE_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const SHA = 'a'.repeat(40);
const OLD_SHA = 'b'.repeat(40);
const DIGEST = `sha256:${'c'.repeat(64)}`;

test('release scopes keep docs and release automation outside product version bumps', () => {
  assert.deepEqual(releaseScopes([
    'docs/extensions.md',
    'packages/docs-site/src/content/docs/index.mdx',
    'scripts/oss-release-check.mjs',
    'scripts/mcp-publish-workflow.test.mjs',
    'scripts/oss-boundary.test.mjs',
    '.github/workflows/test.yml',
  ]), {
    core: false,
    mcp: false,
    docs: true,
  });
  assert.deepEqual(releaseScopes(['packages/mcp-server/src/index.ts']), { core: true, mcp: true, docs: false });
  assert.deepEqual(releaseScopes(['packages/portal/src/lib/release.ts']), { core: true, mcp: false, docs: false });
});

test('a new stable version plans publication for both independently versioned artifacts', () => {
  const plan = buildReleasePlan({ sourceSha: SHA, coreVersion: '1.2.3', mcpVersion: '4.5.6' });
  assert.equal(plan.publish_core, true);
  assert.equal(plan.publish_mcp, true);
  assert.equal(plan.core_source_sha, SHA);
  assert.equal(plan.core_tag, 'core-v1.2.3');
  assert.equal(plan.mcp_tag, 'mcp-v4.5.6');
});

test('Core release metadata does not change the independently packaged MCP artifact', () => {
  assert.deepEqual(releaseScopes(['packages/shared/src/release.ts']), { core: true, mcp: false, docs: false });
  assert.equal(releaseScopes(['packages/shared/src/types.ts']).mcp, true);
  const plan = buildReleasePlan({ sourceSha: SHA, coreVersion: '1.2.4', mcpVersion: '4.5.6',
    mcpTagSha: OLD_SHA, mcpChanges: ['packages/shared/src/release.ts'] });
  assert.equal(plan.publish_core, true);
  assert.equal(plan.publish_mcp, false);
});

test('local product changes require a version bump even when HEAD is the existing tag', () => {
  assert.throws(() => buildReleasePlan({ sourceSha: SHA, coreVersion: '1.2.3', mcpVersion: '4.5.6',
    coreTagSha: SHA, coreChanges: ['packages/portal/src/index.ts'] }), /bump the Core version/);
  assert.throws(() => buildReleasePlan({ sourceSha: SHA, coreVersion: '1.2.3', mcpVersion: '4.5.6',
    mcpTagSha: SHA, mcpChanges: ['packages/mcp-server/src/index.ts'] }), /bump the MCP version/);
});

test('an existing version rejects relevant source drift but permits docs-only follow-ups', () => {
  assert.throws(
    () => buildReleasePlan({
      sourceSha: SHA,
      coreVersion: '1.2.3',
      mcpVersion: '4.5.6',
      coreTagSha: OLD_SHA,
      coreChanges: ['packages/portal/src/index.ts'],
    }),
    /bump the Core version/,
  );
  const docsPlan = buildReleasePlan({
    sourceSha: SHA,
    coreVersion: '1.2.3',
    mcpVersion: '4.5.6',
    coreTagSha: OLD_SHA,
    mcpTagSha: OLD_SHA,
    coreChanges: ['docs/extensions.md'],
    mcpChanges: ['docs/extensions.md'],
  });
  assert.equal(docsPlan.core_source_sha, OLD_SHA);
});

const bundleDescriptor = (release = {}) => ({
  asset: `typeroll-core-${CORE_VERSION}-workers.tar.gz`,
  sha256: DIGEST,
  size: 1234,
  release: {
    core_version: CORE_VERSION,
    source_sha: SHA,
    data_schema_version: 2,
    data_schema_readable: { min: 2, max: 2 },
    content_sha256: 'd'.repeat(64),
    build: { node_version: '22.23.1' },
    workers: { portal: { migration_tag: 'v1', exports: ['DocumentStore', 'OperatorApi', 'default'] } },
    roles: { portal: { worker: 'portal' } },
    ...release,
  },
});

test('the generated release manifest matches the runtime version sources', () => {
  const manifest = buildReleaseManifest({ sourceSha: SHA, bundle: bundleDescriptor(), recordedAt: '2026-09-06' });
  assert.equal(manifest.schema_version, 2);
  assert.equal(manifest.core_version, '0.3.0');
  assert.equal(manifest.mcp_version, '0.45.117');
  assert.equal(manifest.template_capabilities_version, '0.57.0');
  assert.equal(manifest.bundle_digest, DIGEST);
  assert.equal(manifest.operator_api_version, 1);
  assert.equal(manifest.site_hosting_version, 1);
  assert.equal(manifest.image_digest, undefined);
  assert.equal(manifest.bundle.url, `https://github.com/Typeroll/typeroll/releases/download/core-v${CORE_VERSION}/typeroll-core-${CORE_VERSION}-workers.tar.gz`);
  assert.deepEqual(manifest.bundle.provenance, {
    predicate_type: 'https://slsa.dev/provenance/v1',
    signer_workflow: 'Typeroll/typeroll/.github/workflows/publish-mcp.yml',
    source_ref: 'refs/heads/main',
  });
  assert.deepEqual(manifest.data_schema_readable, { min: 2, max: 2 });
});

test('the release manifest refuses a bundle from another source, version or schema', () => {
  for (const release of [{ source_sha: OLD_SHA }, { core_version: '0.2.156' }, { data_schema_version: 3 }, { workers: {} }, { workers: { portal: { migration_tag: 'v1', exports: ['default'] } } }]) {
    assert.throws(() => buildReleaseManifest({ sourceSha: SHA, bundle: bundleDescriptor(release) }), /bundle|OperatorApi/);
  }
  assert.throws(() => buildReleaseManifest({ sourceSha: SHA, bundle: { ...bundleDescriptor(), sha256: 'sha256:abc' } }), /bundle digest/);
  assert.throws(() => buildReleaseManifest({ sourceSha: SHA, bundle: { ...bundleDescriptor(), asset: 'other.tar.gz' } }), /asset=/);
});
