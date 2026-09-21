import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceCheckPlan, resolveSourceCheckPlan } from './source-check-plan.mjs';

const docs = ['packages/docs-site/src/content/docs/tools/deploy.md', 'docs/releasing.md'];
const qualified = { files: docs, baselineQualified: true, completeRange: true };
test('only a complete documentation delta on a qualified baseline uses the short lane', () => {
  assert.equal(sourceCheckPlan(qualified).docs_only, true);
  for (const change of [{ baselineQualified: false }, { completeRange: false }, { files: [] }]) {
    assert.equal(sourceCheckPlan({ ...qualified, ...change }).docs_only, false);
  }
  for (const file of ['package-lock.json', '.github/workflows/test.yml', 'scripts/source-check-plan.mjs',
    'packages/shared/src/pages.ts', 'packages/portal/src/styles/editor.css',
    'packages/docs-site/package.json', 'packages/docs-site/scripts/build.mjs', 'docs/../../package.json', 'unknown']) {
    assert.equal(sourceCheckPlan({ ...qualified, files: [...docs, file] }).docs_only, false, file);
  }
});
test('GitHub baseline proof is exact and transport or history failures run full checks', () => {
  const before = 'a'.repeat(40), sha = 'b'.repeat(40);
  const proof = { conclusion: 'success', status: 'completed', event: 'push', head_branch: 'main',
    head_sha: before, head_repository: { full_name: 'Typeroll/typeroll' }, path: '.github/workflows/test.yml' };
  const input = { event: { before, ref: 'refs/heads/main' }, eventName: 'push', sha, repository: 'Typeroll/typeroll' };
  const runner = item => (cmd, args) => cmd === 'gh' ? JSON.stringify({ workflow_runs: [item] }) : args[0] === 'diff' ? docs.join('\0') : '';
  assert.equal(resolveSourceCheckPlan({ ...input, run: runner(proof) }).docs_only, true);
  for (const item of [{ ...proof, conclusion: 'failure' }, { ...proof, head_sha: sha }, { ...proof, event: 'pull_request' }, { ...proof, head_repository: { full_name: 'fork/repo' } }]) {
    assert.equal(resolveSourceCheckPlan({ ...input, run: runner(item) }).docs_only, false);
  }
  assert.equal(resolveSourceCheckPlan({ ...input, run: () => { throw Error('unavailable'); } }).docs_only, false);
  for (const change of [{ eventName: 'pull_request' }, { event: { before: '0'.repeat(40), ref: 'refs/heads/main' } }]) {
    assert.equal(resolveSourceCheckPlan({ ...input, ...change, run: () => { throw Error('must not read'); } }).docs_only, false);
  }
});
