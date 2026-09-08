import { describe, it, expect, beforeEach, vi } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { paths } from '@typeroll/shared';

// We don't run the full deploy in this test (no astro build inside CI).
// What we DO test: getDeployQueue picks the right backend based on env vars,
// CloudTasksQueue refuses to instantiate without its required config, and
// the in-process backend correctly marks failures on the job doc.

describe('getDeployQueue', () => {
  beforeEach(async () => {
    vi.resetModules();
    await resetDatastore();
    delete process.env.DEPLOY_QUEUE;
    delete process.env.CLOUD_TASKS_QUEUE;
    delete process.env.DEPLOY_WORKER_URL;
    delete process.env.CLOUD_TASKS_SERVICE_ACCOUNT;
  });

  it('defaults to in-process', async () => {
    const { InProcessQueue, getDeployQueue } = await import('../../lib/deploy/queue');
    expect(getDeployQueue()).toBeInstanceOf(InProcessQueue);
  });

  it('requires all three Cloud Tasks env vars when mode=cloud_tasks', async () => {
    process.env.DEPLOY_QUEUE = 'cloud_tasks';
    const mod = await import('../../lib/deploy/queue');
    expect(() => mod.getDeployQueue()).toThrow(/CLOUD_TASKS_QUEUE/);
  });

  it('selects the durable Firestore queue for self-hosted production', async () => {
    process.env.DEPLOY_QUEUE = 'firestore';
    const { FirestoreDeployQueue, getDeployQueue } = await import('../../lib/deploy/queue');
    expect(getDeployQueue()).toBeInstanceOf(FirestoreDeployQueue);
  });

  it('rejects an unsupported queue mode instead of silently running in-process', async () => {
    process.env.DEPLOY_QUEUE = 'typo';
    const { getDeployQueue } = await import('../../lib/deploy/queue');
    expect(() => getDeployQueue()).toThrow(/Unsupported DEPLOY_QUEUE mode/);
  });

  it('rejects a missing site before accepting a deployment', async () => {
    makeTmpFixtures();
    await resetDatastore();
    const { getStore } = await import('../../lib/datastore');
    const { InProcessQueue } = await import('../../lib/deploy/queue');
    // Pre-create a queued job; no site doc → runDeploy throws "Site not found".
    const jobId = await getStore().addDoc(paths.deploys('o', 'no-such-site'), {
      version_id: 'main',
      environment: 'staging',
      status: 'queued',
      started_at: new Date().toISOString(),
    });
    const q = new InProcessQueue();
    await expect(q.enqueue({
      jobId,
      orgId: 'o',
      siteId: 'no-such-site',
      versionId: 'main',
      environment: 'staging',
    })).rejects.toThrow('Site not found');
  });
});


it('uses a separate deterministic queue identity for a frozen publication continuation', async () => {
  const { deployTaskIdentity, firestoreDeployQueueItemId } = await import('../../lib/deploy/queue');
  const initial = { orgId: 'org', siteId: 'site', jobId: 'job' };
  const continued = { ...initial, dispatchKey: 'a'.repeat(16) };
  expect(deployTaskIdentity(initial)).toBe('job');
  expect(deployTaskIdentity(continued)).toBe('job-' + 'a'.repeat(16));
  expect(firestoreDeployQueueItemId(continued)).not.toBe(firestoreDeployQueueItemId(initial));
  expect(firestoreDeployQueueItemId(continued)).toBe(firestoreDeployQueueItemId({ ...continued }));
  expect(() => deployTaskIdentity({ ...initial, dispatchKey: '../other' })).toThrow('identity');
});
