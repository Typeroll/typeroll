import { beforeEach, expect, it, vi } from 'vitest';
import { paths } from '@typeroll/shared';
import { getStore } from '../../lib/datastore';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { ConnectionError } from '../../lib/publishing/connections';

const provider = vi.hoisted(() => ({ status: 'stopped', dispatch: vi.fn() }));
vi.mock('../../lib/publishing/cloudflare-oauth', () => ({ cloudflareClient: async () => async () => ({ status: provider.status }) }));
vi.mock('../../lib/builds/state', async original => ({
  ...await original<typeof import('../../lib/builds/state')>(),
  readEngineConfiguration: async () => ({ revision: 'engine', account_id: 'a'.repeat(32), provider: 'cloudflare' }),
}));
vi.mock('../../lib/builds/jobs', () => ({ dispatchPendingBuild: provider.dispatch }));

const { refreshBuildFailure } = await import('../../lib/builds/failure-status');
const jobPath = paths.deploy('org', 'site', 'job'), taskPath = 'organizations/org/build_tasks/task';

beforeEach(async () => {
  makeTmpFixtures(); await resetDatastore();
  provider.status = 'stopped'; provider.dispatch.mockReset();
  await getStore().setDoc(jobPath, { status: 'running', phase: 'building on Cloudflare', git_publication: { build_task_key: 'task' } });
  await getStore().setDoc(taskPath, { status: 'queued', attempt: 0, lease_until: 0, engine_revision: 'engine', created_at: Date.now(), queued_at: Date.now(), deadline: Date.now() + 60_000, identity: { org_id: 'org', site_id: 'site', job_id: 'job' } });
  await getStore().setDoc('organizations/org/build_inputs/task', { provider: 'cloudflare', kind: 'publication', dispatch_id: 'b'.repeat(36), source_key: 'source', storage_account_id: 'a'.repeat(32) });
});

it('starts a runner again when a shared Cloudflare runner stopped before claiming the task', async () => {
  const job = await refreshBuildFailure('org', 'site', (await getStore().getDoc<any>(jobPath))!);
  expect(provider.dispatch).toHaveBeenCalledWith('org', 'task', expect.objectContaining({ revision: 'engine' }));
  expect(job).toMatchObject({ status: 'running' });
  expect(await getStore().getDoc(taskPath)).toMatchObject({ status: 'queued' });
});

it('leaves a task alone while its Cloudflare runner is still running', async () => {
  provider.status = 'running';
  expect(await refreshBuildFailure('org', 'site', (await getStore().getDoc<any>(jobPath))!)).toMatchObject({ status: 'running' });
  expect(provider.dispatch).not.toHaveBeenCalled();
});

it('names the runner start failure once every bounded dispatch was stopped', async () => {
  provider.dispatch.mockRejectedValue(new ConnectionError('Cloudflare could not start the shared runner.', 502, 'shared_runner_start_failed'));
  const job = await refreshBuildFailure('org', 'site', (await getStore().getDoc<any>(jobPath))!);
  expect(job).toMatchObject({ status: 'failed', failure: { code: 'shared_runner_start_failed' } });
  expect(job.error).toContain('Cloudflare stopped every shared build runner');
  expect(job.error).not.toContain('build_result_missing');
});
