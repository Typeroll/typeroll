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

test('MCP publication is serialized and uses pinned Trusted Publishing tooling', () => {
  assert.match(workflow, /concurrency:\s*\n\s+group: publish-mcp\s*\n\s+cancel-in-progress: false/);
  assert.match(workflow, /id-token: write/);
  assert.match(workflow, /npm install --global npm@11\.6\.2/);
  assert.match(workflow, /npm publish --access public --provenance/);
});

test('MCP publication verifies npm before creating the release tag', () => {
  const publish = workflow.indexOf('- name: Publish to npm');
  const verify = workflow.indexOf('- name: Verify npm release');
  const tag = workflow.indexOf('- name: Create release tag');

  assert.ok(publish >= 0, 'publish step is missing');
  assert.ok(verify > publish, 'npm verification must follow publication');
  assert.ok(tag > verify, 'release tag must follow npm verification');
  assert.match(workflow, /dry_run:[\s\S]*?default: true/);
});
