// The deploy queue writes one scheduled `deploy_dispatch` entry per job; the
// scheduling executor delivers it to executeDeployJob. No astro build runs
// here: executeDeployJob is a mock, the job document and the entry are real.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MAIN_VERSION_ID, paths } from '@typeroll/shared';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { getStore } from '../../lib/datastore';
import { workPath, type ScheduledWork } from '../../lib/scheduling/index';
import { executeScheduledWork } from '../../lib/scheduling/worker';

const mocks = vi.hoisted(() => ({ execute: vi.fn(), ready: vi.fn() }));
vi.mock('../../lib/deploy/queue', async original => ({ ...await original<object>(), executeDeployJob: mocks.execute }));
vi.mock('../../lib/publishing/readiness', async original => {
  const actual = await original<typeof import('../../lib/publishing/readiness')>();
  mocks.ready.mockImplementation(actual.assertPublishingReady);
  return { ...actual, assertPublishingReady: mocks.ready };
});
import { deployTaskIdentity, getDeployQueue, ScheduledDeployQueue } from '../../lib/deploy/queue';

const ORG = 'org', SITE = 'site', JOB = 'job';
const jobPath = paths.deploy(ORG, SITE, JOB), eventPath = workPath(jobPath, 'deploy_dispatch');
const id = eventPath.split('/').pop()!;
const args = { orgId: ORG, siteId: SITE, jobId: JOB, versionId: MAIN_VERSION_ID, environment: 'production' as const };
const entry = () => getStore().getDoc<ScheduledWork>(eventPath);

beforeEach(async () => {
  makeTmpFixtures(); await resetDatastore();
  mocks.execute.mockReset().mockResolvedValue('ran');
  mocks.ready.mockReset().mockResolvedValue({ ready: true });
  await getStore().setDoc(paths.site(ORG, SITE), { name: 'Site' });
  await getStore().setDoc(jobPath, { version_id: MAIN_VERSION_ID, environment: 'production', status: 'queued', started_at: new Date().toISOString() });
});

describe('enqueue', () => {
  it('is the scheduled queue in every environment', () => {
    expect(getDeployQueue()).toBeInstanceOf(ScheduledDeployQueue);
  });

  it('writes one deterministic dispatch per request and a separate one per continuation', async () => {
    const queue = new ScheduledDeployQueue(() => 1_000);
    await queue.enqueue(args);
    const first = await entry();
    expect(first).toMatchObject({ kind: 'deploy_dispatch', source: jobPath, generation: JOB, due_at: 1_000,
      payload: { version_id: MAIN_VERSION_ID, environment: 'production', dry_run: false, dispatch_key: null } });
    // A retried request is the same delivery, not a second one.
    await new ScheduledDeployQueue(() => 2_000).enqueue(args);
    expect(await entry()).toEqual(first);
    // A continuation of the same job replaces it, delayed as requested.
    await new ScheduledDeployQueue(() => 3_000).enqueue({ ...args, dispatchKey: 'a'.repeat(16), delayMs: 60_000 });
    expect(await entry()).toMatchObject({ generation: `${JOB}-${'a'.repeat(16)}`, due_at: 63_000 });
    expect(mocks.ready).toHaveBeenLastCalledWith(ORG, SITE, MAIN_VERSION_ID, { checkBuild: false });
  });

  it('rejects a missing site before accepting a deployment', async () => {
    mocks.ready.mockImplementation((await vi.importActual<typeof import('../../lib/publishing/readiness')>('../../lib/publishing/readiness')).assertPublishingReady);
    await getStore().deleteDoc(paths.site(ORG, SITE));
    await expect(getDeployQueue().enqueue(args)).rejects.toThrow('Site not found');
    expect(await entry()).toBeNull();
  });

  it('accepts a random continuation identity and refuses a path-like one', () => {
    expect(deployTaskIdentity({ jobId: JOB, dispatchKey: '0b6f1c2e-6d0e-4d3a-9a51-1f1b6a7c0c55' })).toBe(`${JOB}-0b6f1c2e-6d0e-4d3a-9a51-1f1b6a7c0c55`);
    expect(() => deployTaskIdentity({ jobId: JOB, dispatchKey: '../other' })).toThrow('identity');
  });
});

describe('delivery', () => {
  it('forwards dryRun and consumes the dispatch exactly once', async () => {
    await getDeployQueue().enqueue({ ...args, dryRun: true });
    const { generation } = (await entry())!;
    await executeScheduledWork(id, generation);
    await executeScheduledWork(id, generation);
    expect(mocks.execute).toHaveBeenCalledOnce();
    expect(mocks.execute).toHaveBeenCalledWith(expect.objectContaining({ jobId: JOB, orgId: ORG, siteId: SITE, dryRun: true }), expect.objectContaining({ slotWaitMs: expect.any(Number) }));
    expect((await entry())!.due_at).toBe(Number.MAX_SAFE_INTEGER);
  });

  it.each(['customer_git', 'organization_cloudflare', 'organization_github'] as const)('retries a busy %s delivery without starting an observation chain', async execution_backend => {
    await getStore().updateDoc(jobPath, { status: 'running', execution_backend });
    await getDeployQueue().enqueue(args);
    const { generation } = (await entry())!;
    mocks.execute.mockResolvedValueOnce('deferred');
    await expect(executeScheduledWork(id, generation)).rejects.toThrow('retry');
    expect((await entry())!.lease_until).toBe(0);
    expect((await getStore().getDoc<any>(jobPath)).continuation).toBeUndefined();
    mocks.execute.mockResolvedValueOnce('waiting');
    await executeScheduledWork(id, generation);
    expect((await entry())!.due_at).toBe(Number.MAX_SAFE_INTEGER);
    expect(mocks.execute).toHaveBeenCalledTimes(2);
  });

  it('saves one checkpoint when an external coordinator continues', async () => {
    await getStore().updateDoc(jobPath, { status: 'running', execution_backend: 'organization_cloudflare' });
    await getDeployQueue().enqueue(args);
    mocks.execute.mockResolvedValueOnce('continue');
    await executeScheduledWork(id, (await entry())!.generation);
    expect((await getStore().getDoc<any>(jobPath)).continuation).toMatchObject({ reason: 'checkpoint' });
    expect(await getStore().getDoc(workPath(jobPath, 'publication'))).toMatchObject({ kind: 'publication' });
  });

  it('never restarts a managed job that is already running, or a finished one', async () => {
    await getDeployQueue().enqueue(args);
    await getStore().updateDoc(jobPath, { status: 'running' });
    await executeScheduledWork(id, (await entry())!.generation);
    await getStore().updateDoc(jobPath, { status: 'succeeded' });
    await getDeployQueue().enqueue({ ...args, dispatchKey: 'b'.repeat(16) });
    await executeScheduledWork(id, (await entry())!.generation);
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});
