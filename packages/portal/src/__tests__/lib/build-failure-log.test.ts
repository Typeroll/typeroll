import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { paths } from '@typeroll/shared';
import { getStore } from '../../lib/datastore';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';

const provider = vi.hoisted(() => ({ pages: [] as any[], routes: [] as string[], fail: false }));
vi.mock('../../lib/publishing/cloudflare-oauth', () => ({
  cloudflareClient: async () => async (route: string) => {
    provider.routes.push(route);
    if (provider.fail) throw new Error('Cloudflare unavailable');
    return provider.pages.shift() ?? { lines: [], truncated: false };
  },
}));
vi.mock('../../lib/builds/state', async (original) => ({
  ...(await original<typeof import('../../lib/builds/state')>()),
  readEngineConfiguration: async () => ({ account_id: 'a'.repeat(32), revision: 'engine' }),
}));

const { attachBuildFailureLog, failureSummary, logMessages, readCloudflareBuildLog, redactLogLine } = await import('../../lib/builds/failure-log');
const { buildInputPath } = await import('../../lib/builds/state');

const jobPath = paths.deploy('org', 'site', 'job'), taskPath = 'organizations/org/build_tasks/task';
const generic = 'The build engine reported a failed or cancelled attempt. Check the build log, then retry publishing.';
beforeEach(async () => {
  makeTmpFixtures(); await resetDatastore();
  provider.pages = []; provider.routes = []; provider.fail = false;
  await getStore().setDoc(jobPath, { id: 'job', status: 'failed', phase: 'building on Cloudflare', error: generic,
    failure: { stage: 'building on Cloudflare', code: 'shared_build_failed' }, git_publication: { build_task_key: 'task' } });
  await getStore().setDoc(taskPath, { status: 'failed', error_code: 'shared_build_failed', identity: { org_id: 'org', site_id: 'site', job_id: 'job' } });
  await getStore().setDoc(buildInputPath('org', 'task'), { provider: 'cloudflare', dispatch_id: 'build-uuid' });
});
afterEach(() => vi.restoreAllMocks());

it('names the cause from the provider log on a failed job and keeps the tail for every reader', async () => {
  provider.pages = [{ cursor: 'next', truncated: true, lines: [[1, 'Initializing build environment...'], [2, 'npm ci']] },
    { truncated: false, lines: [[3, '[vite] error during build:'], [4, 'Error: Cannot find module @rolldown/binding-linux-x64-gnu'], [5, 'Failed: build command exited with code: 1']] }];
  const job = await attachBuildFailureLog('org', 'site', (await getStore().getDoc<any>(jobPath))!);
  expect(provider.routes).toEqual([
    `/accounts/${'a'.repeat(32)}/builds/builds/build-uuid/logs`,
    `/accounts/${'a'.repeat(32)}/builds/builds/build-uuid/logs?cursor=next`,
  ]);
  expect(job.error).toBe(`${generic} Build log: Error: Cannot find module @rolldown/binding-linux-x64-gnu`);
  expect(job.failure).toMatchObject({ code: 'shared_build_failed', provider_log: { provider: 'cloudflare', build_id: 'build-uuid', step: 'build', error_code: 'shared_build_failed',
    summary: 'Error: Cannot find module @rolldown/binding-linux-x64-gnu', truncated: false } });
  expect(job.failure!.provider_log!.lines.at(-1)).toBe('Failed: build command exited with code: 1');
  // Read once: a later status read does not ask Cloudflare again.
  await attachBuildFailureLog('org', 'site', job);
  expect(provider.routes).toHaveLength(2);
});

it('leaves running, successful and unreadable jobs unchanged', async () => {
  await getStore().updateDoc(jobPath, { status: 'running' });
  expect(await attachBuildFailureLog('org', 'site', (await getStore().getDoc<any>(jobPath))!)).toMatchObject({ status: 'running', error: generic });
  await getStore().updateDoc(jobPath, { status: 'failed' });
  provider.fail = true;
  const job = await attachBuildFailureLog('org', 'site', (await getStore().getDoc<any>(jobPath))!);
  expect(job.error).toBe(generic);
  expect(job.failure?.provider_log).toBeUndefined();
});

it('never reads a build that belongs to another job', async () => {
  await getStore().updateDoc(taskPath, { identity: { org_id: 'org', site_id: 'site', job_id: 'other' } });
  await attachBuildFailureLog('org', 'site', (await getStore().getDoc<any>(jobPath))!);
  expect(provider.routes).toEqual([]);
});

it('removes credential-shaped values but keeps digests and commit IDs', () => {
  expect(redactLogLine('Authorization: Bearer abc.def-123')).toBe('Authorization: [redacted]');
  expect(redactLogLine('curl -H "Bearer sk_live_1234"')).toBe('curl -H "Bearer [redacted]"');
  expect(redactLogLine('CLOUDFLARE_API_TOKEN=Abc123xyz')).toBe('CLOUDFLARE_API_TOKEN=[redacted]');
  expect(redactLogLine('git clone https://x-access-token:ghs_Abc123@github.com/o/r')).toBe('git clone https://[redacted]@github.com/o/r');
  expect(redactLogLine('GET https://r2.example/a?X-Amz-Signature=abc123&x=1')).toBe('GET https://r2.example/a?X-Amz-Signature=[redacted]&x=1');
  expect(redactLogLine('session eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U')).toBe('session [redacted]');
  expect(redactLogLine('opaque Zm9vYmFyQmF6UXV4MTIzNDU2Nzg5MEFCQ0RFRkdI')).toBe('opaque [redacted]');
  const digest = 'sha256:' + 'ab12'.repeat(16), commit = 'e92d5806220bb7452d7df998a0530e80c659bf7e';
  expect(redactLogLine(`artifact ${digest} from ${commit}`)).toBe(`artifact ${digest} from ${commit}`);
  expect(redactLogLine('\u001b[31mError\u001b[0m: boom')).toBe('Error: boom');
  expect(redactLogLine('x'.repeat(1000))).toHaveLength(400);
});

it('reads Cloudflare log lines and picks the most specific failure', () => {
  expect(logMessages([[1, 'one\ntwo'], [2, ''], 'three', [3]])).toEqual(['one', 'two', 'three']);
  expect(logMessages(undefined)).toEqual([]);
  expect(failureSummary(['ok', 'npm ERR! code ERESOLVE', 'npm ERR! A complete log of this run can be found in /x', 'Failed: build command exited with code: 1'])).toBe('npm ERR! code ERESOLVE');
  expect(failureSummary(['Failed: build command exited with code: 1'])).toBe('Failed: build command exited with code: 1');
  expect(failureSummary(['all good'])).toBeNull();
});

it('stops paging at a bound and reports the log as truncated', async () => {
  const client = async () => ({ cursor: `c${Math.random()}`, truncated: true, lines: [[1, 'line']] });
  const result = await readCloudflareBuildLog(client, 'acct', 'build');
  expect(result.truncated).toBe(true);
  expect(result.messages.length).toBeLessThanOrEqual(240);
});
