import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceCheckPlan, resolveSourceCheckPlan, resolvePrQualification, qualificationRecord, releaseTags, recordName } from './source-check-plan.mjs';

const docs = ['packages/docs-site/src/content/docs/tools/deploy.md', 'docs/releasing.md'];
const qualified = { files: docs, baselineQualified: true, completeRange: true };
test('only a complete documentation delta on a qualified baseline uses the short lane', () => {
  assert.equal(sourceCheckPlan(qualified).docs_only, true);
  assert.equal(sourceCheckPlan(qualified).lane, 'docs');
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
  // No pull request record exists, so anything but the docs lane is the full gate.
  const runner = item => (cmd, args) => cmd === 'gh' ? JSON.stringify(args[1].includes('/artifacts?') ? { artifacts: [] } : { workflow_runs: [item] })
    : args[0] === 'diff' ? docs.join('\0') : args[0] === 'rev-parse' ? 'c'.repeat(40) : '';
  assert.equal(resolveSourceCheckPlan({ ...input, run: runner(proof) }).docs_only, true);
  for (const item of [{ ...proof, conclusion: 'failure' }, { ...proof, head_sha: sha }, { ...proof, event: 'pull_request' }, { ...proof, head_repository: { full_name: 'fork/repo' } }]) {
    assert.equal(resolveSourceCheckPlan({ ...input, run: runner(item) }).lane, 'full');
  }
  assert.equal(resolveSourceCheckPlan({ ...input, run: () => { throw Error('unavailable'); } }).lane, 'full');
  for (const change of [{ eventName: 'pull_request' }, { event: { before, ref: 'refs/heads/other' } }, { repository: 'fork/typeroll' }]) {
    assert.equal(resolveSourceCheckPlan({ ...input, ...change, run: () => { throw Error('must not read'); } }).lane, 'full');
  }
});

// A main push whose tree a same-repository pull request run fully qualified.
const repository = 'Typeroll/typeroll';
const main = 'b'.repeat(40), tree = 'c'.repeat(40), merge = 'd'.repeat(40), head = 'e'.repeat(40), base = 'f'.repeat(40);
const tagRefs = 'refs/tags/core-v0.2.81 1111111111111111111111111111111111111111\n';
const prRun = { id: 7, conclusion: 'success', status: 'completed', event: 'pull_request', head_sha: head,
  repository: { full_name: repository }, head_repository: { full_name: repository }, path: '.github/workflows/test.yml' };
const record = { version: 1, repository, lane: 'full', sha: merge, tree, release_tags: releaseTags(() => tagRefs) };
function github({ run = prRun, runs = [run], artifact = { name: recordName(tree), expired: false, workflow_run: { id: 7 } },
  commit = { sha: merge, tree: { sha: tree }, parents: [{ sha: base }, { sha: head }] }, mainTree = tree, tags = tagRefs, calls = [] } = {}) {
  let reads = 0;
  return {
    calls,
    run: (cmd, args) => {
      calls.push([cmd, ...args].join(' '));
      if (cmd === 'git' && args[0] === 'rev-parse') { assert.equal(args[1], `${main}^{tree}`); return `${mainTree}\n`; }
      if (cmd === 'git' && args[0] === 'for-each-ref') return tags;
      if (cmd === 'git') throw Error('no docs-only history in this case');
      const endpoint = args[1];
      if (endpoint === `/repos/${repository}/actions/artifacts?name=${recordName(mainTree)}&per_page=100`) return JSON.stringify({ artifacts: [artifact] });
      if (endpoint === `/repos/${repository}/actions/runs/7`) return JSON.stringify(runs[Math.min(reads++, runs.length - 1)]);
      if (endpoint === `/repos/${repository}/git/commits/${merge}`) return JSON.stringify(commit);
      throw Error(`unexpected ${endpoint}`);
    },
  };
}
const resolve = (gh, read = () => JSON.stringify(record), extra = {}) =>
  resolveSourceCheckPlan({ event: { before: '0'.repeat(40), ref: 'refs/heads/main' }, eventName: 'push', sha: main, repository, run: gh.run, read, ...extra });

test('an identical tree fully qualified by a same-repository pull request run is not tested again', () => {
  const plan = resolve(github());
  assert.equal(plan.lane, 'reuse');
  assert.equal(plan.docs_only, false);
  assert.match(plan.reason, new RegExp(`run 7 at ${merge}`));
});

test('every unproven pull request claim selects the full gate', () => {
  const cases = {
    'failed run': github({ run: { ...prRun, conclusion: 'failure' } }),
    'cancelled run': github({ run: { ...prRun, conclusion: 'cancelled' } }),
    'incomplete run': github({ run: { ...prRun, status: 'in_progress', conclusion: null } }),
    'fork pull request': github({ run: { ...prRun, head_repository: { full_name: 'fork/typeroll' } } }),
    'other repository': github({ run: { ...prRun, repository: { full_name: 'fork/typeroll' } } }),
    'push run': github({ run: { ...prRun, event: 'push' } }),
    'other workflow file': github({ run: { ...prRun, path: '.github/workflows/other.yml' } }),
    'expired record': github({ artifact: { name: recordName(tree), expired: true, workflow_run: { id: 7 } } }),
    'other record name': github({ artifact: { name: 'pr-qualified-other', expired: false, workflow_run: { id: 7 } } }),
    'main moved after PR CI': github({ mainTree: '9'.repeat(40) }),
    'release tags changed after PR CI': github({ tags: `${tagRefs}refs/tags/core-v0.2.82 2222222222222222222222222222222222222222\n` }),
    'tested commit has another tree': github({ commit: { sha: merge, tree: { sha: '9'.repeat(40) }, parents: [{ sha: base }, { sha: head }] } }),
    'tested commit does not merge the PR head': github({ commit: { sha: merge, tree: { sha: tree }, parents: [{ sha: base }] } }),
  };
  for (const [name, gh] of Object.entries(cases)) assert.equal(resolve(gh).lane, 'full', name);
  for (const [name, change] of Object.entries({ 'docs-only lane': { lane: 'docs' }, 'record for another tree': { tree: '9'.repeat(40) },
    'record from another repository': { repository: 'fork/typeroll' }, 'record without a commit': { sha: 'main' },
    'unknown record version': { version: 2 }, 'record with other tags': { release_tags: '0'.repeat(64) } })) {
    assert.equal(resolve(github(), () => JSON.stringify({ ...record, ...change })).lane, 'full', name);
  }
  assert.equal(resolve(github(), () => 'not json').lane, 'full', 'unreadable record');
  assert.equal(resolve(github(), () => { throw Error('artifact download failed'); }).lane, 'full', 'download failure');
  const unavailable = github();
  const failing = { run: (cmd, args) => { if (cmd === 'gh' && args[1].includes('/git/commits/')) throw Error('HTTP 404'); return unavailable.run(cmd, args); } };
  assert.equal(resolve(failing).lane, 'full', 'commit lookup failure');
});

test('a pull request run that GitHub is still completing is awaited, but only briefly', () => {
  let waited = 0;
  const finishing = github({ runs: [{ ...prRun, status: 'in_progress', conclusion: null }, prRun] });
  assert.equal(resolve(finishing, undefined, { wait: () => waited++ }).lane, 'reuse');
  assert.equal(waited, 1);
  waited = 0;
  const running = github({ run: { ...prRun, status: 'in_progress', conclusion: null } });
  assert.equal(resolvePrQualification({ sha: main, repository, run: running.run, read: () => JSON.stringify(record), wait: () => waited++, maxWaits: 3 }), null);
  assert.equal(waited, 3);
});

test('pull request runs record the exact tested commit, tree and release tags', () => {
  const run = (cmd, args) => args[0] === 'for-each-ref' ? tagRefs : args[1] === 'HEAD' ? `${merge}\n` : `${tree}\n`;
  assert.deepEqual(qualificationRecord({ repository, sha: merge, run }), record);
  for (const input of [{ repository: 'fork/typeroll', sha: merge }, { repository, sha: head }, { repository, sha: undefined }]) {
    assert.throws(() => qualificationRecord({ ...input, run }), /Unexpected qualification identity/);
  }
});
