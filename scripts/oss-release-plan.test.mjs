import assert from 'node:assert/strict';
import test from 'node:test';

import { buildReleaseManifest, buildReleasePlan, releaseScopes } from './oss-release-plan.mjs';

const SHA = 'a'.repeat(40);
const OLD_SHA = 'b'.repeat(40);
const DIGEST = `sha256:${'c'.repeat(64)}`;

test('release scopes keep docs and release automation outside product version bumps', () => {
  assert.deepEqual(releaseScopes([
    'docs/extensions.md',
    'packages/docs-site/src/content/docs/index.mdx',
    'scripts/oss-release-check.mjs',
    'scripts/mcp-publish-workflow.test.mjs',
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

test('the generated release manifest matches the runtime version sources', () => {
  const manifest = buildReleaseManifest({ sourceSha: SHA, imageDigest: DIGEST, recordedAt: '2026-09-06' });
  assert.equal(manifest.core_version, '0.1.26');
  assert.equal(manifest.mcp_version, '0.44.0');
  assert.equal(manifest.template_capabilities_version, '0.43.1');
  assert.equal(manifest.image_digest, DIGEST);
  assert.deepEqual(manifest.data_schema_readable, { min: 1, max: 1 });
});
