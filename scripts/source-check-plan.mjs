// Only documentation on top of an already qualified source may use the short lane.
// A main tree that a same-repository pull request run fully qualified is not tested twice.
import { execFileSync } from 'node:child_process';
import { readFileSync, appendFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { qualifiedRun } from './qualified-docs.mjs';

const GIT_SHA = /^[a-f0-9]{40}$/;
const RECORD_FILE = 'pr-qualification.json';
export const recordName = tree => `pr-qualified-${tree}`;

export function sourceCheckPlan({ files = [], baselineQualified = false, completeRange = false, prQualified = null } = {}) {
  const documentation = file =>
    /^(?:docs\/|packages\/docs-site\/src\/content\/).+\.mdx?$/.test(file) ||
    /^(?:AGENTS|README|SECURITY|CONTRIBUTING|CHANGELOG)\.md$/.test(file);
  const docsOnly = baselineQualified && completeRange && files.length > 0 && files.every(documentation);
  if (docsOnly) return { lane: 'docs', docs_only: true, reason: 'Documentation only on a qualified baseline' };
  if (prQualified) return { lane: 'reuse', docs_only: false, reason: `Identical tree ${prQualified.tree} fully qualified by pull request run ${prQualified.run_id} at ${prQualified.sha}` };
  return { lane: 'full', docs_only: false, reason: 'Full qualification: runtime, unknown files or unqualified baseline' };
}

// Release tags feed the upgrade check and release plan, so they are part of what
// a run qualified. Tags are append-only: one created after the record changes it.
export function releaseTags(run) {
  const refs = run('git', ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/tags/core-v*', 'refs/tags/mcp-v*']);
  return createHash('sha256').update(refs).digest('hex');
}

export function qualificationRecord({ repository, sha, run }) {
  const head = run('git', ['rev-parse', 'HEAD']).trim();
  const tree = run('git', ['rev-parse', 'HEAD^{tree}']).trim();
  if (repository !== 'Typeroll/typeroll' || !GIT_SHA.test(sha ?? '') || head !== sha || !GIT_SHA.test(tree)) throw Error('Unexpected qualification identity');
  return { version: 1, repository, lane: 'full', sha, tree, release_tags: releaseTags(run) };
}

export function prQualifiedRun(run, repository) {
  return run?.conclusion === 'success' && run.status === 'completed' && run.event === 'pull_request' &&
    run.repository?.full_name === repository && run.head_repository?.full_name === repository &&
    run.path === '.github/workflows/test.yml';
}

// For pull_request runs GITHUB_SHA is the test merge commit, which the run API does
// not expose, so the run records it. Every recorded claim is checked against GitHub.
export function resolvePrQualification({ sha, repository, run, read, wait = () => {}, maxWaits = 12 }) {
  const tree = run('git', ['rev-parse', `${sha}^{tree}`]).trim();
  if (!GIT_SHA.test(tree)) return null;
  const tags = releaseTags(run);
  const name = recordName(tree);
  const api = endpoint => JSON.parse(run('gh', ['api', `/repos/${repository}/${endpoint}`]));
  let waits = maxWaits;
  for (const artifact of api(`actions/artifacts?name=${name}&per_page=100`).artifacts) {
    if (artifact.name !== name || artifact.expired) continue;
    let item = api(`actions/runs/${artifact.workflow_run.id}`);
    // Auto-merge can push main moments before GitHub marks the PR run completed.
    while (item.status !== 'completed' && waits-- > 0) {
      wait();
      item = api(`actions/runs/${artifact.workflow_run.id}`);
    }
    if (!prQualifiedRun(item, repository)) continue;
    const record = JSON.parse(read(item.id, name));
    if (record.version !== 1 || record.repository !== repository || record.lane !== 'full' ||
        record.tree !== tree || record.release_tags !== tags || !GIT_SHA.test(record.sha ?? '')) continue;
    // The tested commit must exist with this tree and merge the run's PR head.
    const commit = api(`git/commits/${record.sha}`);
    if (commit.sha !== record.sha || commit.tree?.sha !== tree || !commit.parents?.some(parent => parent.sha === item.head_sha)) continue;
    return { run_id: item.id, sha: record.sha, tree };
  }
  return null;
}

// Inspect the complete tested merge against its qualified main parent, not just
// the PR file list: an old branch may carry runtime changes or revert newer code.
export function resolveDocsPullRequest({ event, sha, repository, run }) {
  const pr = event.pull_request;
  if (repository !== 'Typeroll/typeroll' || !GIT_SHA.test(sha ?? '') ||
      pr?.base?.ref !== 'main' || pr.base.repo?.full_name !== repository ||
      pr.head?.repo?.full_name !== repository ||
      !GIT_SHA.test(pr.base.sha ?? '') || !GIT_SHA.test(pr.head.sha ?? '')) return sourceCheckPlan();
  try {
    const parents = run('git', ['rev-list', '--parents', '-n', '1', sha]).trim().split(/\s+/);
    if (parents.length !== 3 || parents[0] !== sha || parents[1] !== pr.base.sha ||
        parents[2] !== pr.head.sha || run('git', ['rev-parse', 'HEAD']).trim() !== sha) return sourceCheckPlan();
    const files = run('git', ['diff', '--name-only', '--no-renames', '-z', pr.base.sha, sha]).split('\0').filter(Boolean);
    if (!sourceCheckPlan({ files, baselineQualified: true, completeRange: true }).docs_only) return sourceCheckPlan();
    const response = JSON.parse(run('gh', ['api', `/repos/${repository}/actions/workflows/test.yml/runs?event=push&head_sha=${pr.base.sha}&per_page=100`]));
    const baselineQualified = response.workflow_runs.some(item => qualifiedRun(item, repository, pr.base.sha));
    return sourceCheckPlan({ files, baselineQualified, completeRange: true });
  } catch { return sourceCheckPlan(); }
}

export function resolveSourceCheckPlan({ event, eventName, sha, repository, run, read, wait }) {
  if (eventName === 'pull_request') return resolveDocsPullRequest({ event, sha, repository, run });
  if (eventName !== 'push' || event.ref !== 'refs/heads/main' || repository !== 'Typeroll/typeroll' || !GIT_SHA.test(sha ?? '')) return sourceCheckPlan();
  if (GIT_SHA.test(event.before ?? '') && !/^0+$/.test(event.before)) {
    try {
      run('git', ['merge-base', '--is-ancestor', event.before, sha]);
      const files = run('git', ['diff', '--name-only', '--no-renames', '-z', event.before, sha]).split('\0').filter(Boolean);
      if (sourceCheckPlan({ files, baselineQualified: true, completeRange: true }).docs_only) {
        // Read failures or a failed/running baseline never select the short lane.
        const response = JSON.parse(run('gh', ['api', `/repos/${repository}/actions/workflows/test.yml/runs?event=push&head_sha=${event.before}&per_page=100`]));
        const baselineQualified = response.workflow_runs.some(item => qualifiedRun(item, repository, event.before));
        if (baselineQualified) return sourceCheckPlan({ files, baselineQualified, completeRange: true });
      }
    } catch { /* try pull request qualification next */ }
  }
  try {
    // Read failures and unproven claims select the full gate, never a skip.
    return sourceCheckPlan({ prQualified: resolvePrQualification({ sha, repository, run, read, wait }) });
  } catch { return sourceCheckPlan(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const repository = process.env.GITHUB_REPOSITORY;
  const [command, directory] = process.argv.slice(2);
  if (command === 'record') {
    if (!directory) throw Error('Usage: source-check-plan.mjs record DIRECTORY');
    const record = qualificationRecord({ repository, sha: process.env.GITHUB_SHA, run });
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, RECORD_FILE), `${JSON.stringify(record, null, 2)}\n`);
    appendFileSync(process.env.GITHUB_OUTPUT, `name=${recordName(record.tree)}\n`);
    console.log(JSON.stringify(record));
  } else {
    const read = (runId, name) => {
      const target = mkdtempSync(path.join(tmpdir(), 'pr-qualification-'));
      run('gh', ['run', 'download', String(runId), '--repo', repository, '--name', name, '--dir', target]);
      const file = [path.join(target, RECORD_FILE), path.join(target, name, RECORD_FILE)].find(existsSync);
      return readFileSync(file ?? path.join(target, RECORD_FILE), 'utf8');
    };
    const plan = resolveSourceCheckPlan({
      event: JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')),
      eventName: process.env.GITHUB_EVENT_NAME, sha: process.env.GITHUB_SHA,
      repository, run, read,
      wait: () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000),
    });
    appendFileSync(process.env.GITHUB_OUTPUT, `lane=${plan.lane}\ndocs_only=${plan.docs_only}\n`);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${plan.reason}\n`);
    console.log(JSON.stringify(plan));
  }
}
