import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export function qualifiedRun(run, repository, sha) {
  return run?.conclusion === 'success' && run.status === 'completed' && run.event === 'push' &&
    run.head_branch === 'main' && run.head_sha === sha && run.head_repository?.full_name === repository &&
    run.path === '.github/workflows/test.yml';
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { REPOSITORY: repository, SOURCE_SHA: sha, EVENT_RUN_ID: eventId } = process.env;
  if (repository !== 'Typeroll/typeroll' || !/^[a-f0-9]{40}$/.test(sha)) throw Error('Unexpected release identity');
  const api = endpoint => JSON.parse(execFileSync('gh', ['api', `/repos/${repository}/${endpoint}`], { encoding: 'utf8' }));
  const runs = eventId ? [api(`actions/runs/${eventId}`)] : api(`actions/workflows/test.yml/runs?head_sha=${sha}&event=push&per_page=100`).workflow_runs;
  const run = runs.find(run => qualifiedRun(run, repository, sha));
  if (!run) throw Error('Exact source has no successful main Tests run; run source qualification first');
  appendFileSync(process.env.GITHUB_OUTPUT, `run_id=${run.id}\n`);
}
