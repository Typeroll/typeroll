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

  it('in-process queue marks the job failed when runDeploy throws', async () => {
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
    await q.enqueue({
      jobId,
      orgId: 'o',
      siteId: 'no-such-site',
      versionId: 'main',
      environment: 'staging',
    });
    // The enqueue is fire-and-forget; poll the doc until it transitions.
    let job: { status?: string; error?: string } | null = null;
    for (let i = 0; i < 50; i++) {
      job = await getStore().getDoc(paths.deploy('o', 'no-such-site', jobId));
      if (job?.status === 'failed' || job?.status === 'succeeded') break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(job?.status).toBe('failed');
    expect(job?.error ?? '').toMatch(/site/i);
  });
});
