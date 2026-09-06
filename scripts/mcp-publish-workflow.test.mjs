import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const workflow = readFileSync(new URL('../.github/workflows/publish-mcp.yml', import.meta.url), 'utf8');

test('MCP publication waits for successful main Tests', () => {
  assert.match(workflow, /workflow_run:\s*\n\s+workflows:\s*\n\s+- Tests/);
  assert.doesNotMatch(workflow, /\n\s+push:\s*\n/);
  assert.match(workflow, /workflow_run\.conclusion == 'success'/);
  assert.match(workflow, /workflow_run\.event == 'push'/);
  assert.match(workflow, /workflow_run\.head_branch == 'main'/);
  assert.match(workflow, /workflow_run\.head_repository\.full_name == github\.repository/);
  assert.match(workflow, /workflow_run\.head_sha/);
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

test('the release train publishes Core, MCP, docs and the manifest in order', () => {
  const core = workflow.indexOf('\n  core:');
  const mcp = workflow.indexOf('\n  mcp:');
  const docs = workflow.indexOf('\n  docs:');
  const manifest = workflow.indexOf('\n  manifest:');
  assert.ok(core > 0 && mcp > core && docs > mcp && manifest > docs);
  assert.match(workflow, /mcp:[\s\S]*needs: \[plan, core\]/);
  assert.match(workflow, /docs:[\s\S]*needs: \[plan, core, mcp\]/);
  assert.match(workflow, /manifest:[\s\S]*needs: \[plan, core, mcp, docs\]/);
  assert.match(workflow, /RELEASE_TYPEROLL_OSS/);
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
