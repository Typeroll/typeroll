// Only documentation on top of an already qualified source may use the short lane.
import { execFileSync } from 'node:child_process';
import { readFileSync, appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { qualifiedRun } from './qualified-docs.mjs';

export function sourceCheckPlan({ files = [], baselineQualified = false, completeRange = false } = {}) {
  const documentation = file =>
    /^(?:docs\/|packages\/docs-site\/src\/content\/).+\.mdx?$/.test(file) ||
    /^(?:AGENTS|README|SECURITY|CONTRIBUTING|CHANGELOG)\.md$/.test(file);
  const docsOnly = baselineQualified && completeRange && files.length > 0 && files.every(documentation);
  return { docs_only: docsOnly, reason: docsOnly ? 'Documentation only on a qualified baseline' : 'Full qualification: runtime, unknown files or unqualified baseline' };
}

export function resolveSourceCheckPlan({ event, eventName, sha, repository, run }) {
  if (eventName !== 'push' || event.ref !== 'refs/heads/main' || repository !== 'Typeroll/typeroll' ||
      !/^[a-f0-9]{40}$/.test(sha ?? '') || !/^[a-f0-9]{40}$/.test(event.before ?? '') || /^0+$/.test(event.before)) return sourceCheckPlan();
  try {
    run('git', ['merge-base', '--is-ancestor', event.before, sha]);
    const files = run('git', ['diff', '--name-only', '--no-renames', '-z', event.before, sha]).split('\0').filter(Boolean);
    if (!sourceCheckPlan({ files, baselineQualified: true, completeRange: true }).docs_only) return sourceCheckPlan();
    // Read failures or a failed/running baseline select the full gate, never a skip.
    const response = JSON.parse(run('gh', ['api', `/repos/${repository}/actions/workflows/test.yml/runs?event=push&head_sha=${event.before}&per_page=100`]));
    const baselineQualified = response.workflow_runs.some(item => qualifiedRun(item, repository, event.before));
    return sourceCheckPlan({ files, baselineQualified, completeRange: true });
  } catch { return sourceCheckPlan(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const plan = resolveSourceCheckPlan({
    event: JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')),
    eventName: process.env.GITHUB_EVENT_NAME, sha: process.env.GITHUB_SHA,
    repository: process.env.GITHUB_REPOSITORY,
    run: (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
  });
  appendFileSync(process.env.GITHUB_OUTPUT, `docs_only=${plan.docs_only}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${plan.reason}\n`);
  console.log(JSON.stringify(plan));
}
