// Cost accounting is wired into executeDeployJob — the ONE execution path
// shared by the in-process queue and the Cloud Tasks worker. These tests pin
// that a terminal job always carries a cost row, including when it failed
// (a failed build burns the same instance time as a successful one, and a
// site stuck in a failure loop must not read as free).

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { paths, MAIN_VERSION_ID } from '@typeroll/shared';
import type { DeployJob } from '@typeroll/shared';

const ORG = 'orgone';
const SITE = 'mysite';
const JOB = 'job1';

// runDeploy is mocked: we're testing the metering wrapper, not the build.
// The phase callback is exercised so the phase breakdown has something real
// to attribute time to.
const runDeployMock = vi.fn();
vi.mock('../../lib/deploy/runner', () => ({
  runDeploy: (args: { onPhase?: (p: string) => unknown }) => runDeployMock(args),
}));

async function seedJob(): Promise<void> {
  const { getStore } = await import('../../lib/datastore');
  const store = getStore();
  await store.setDoc(paths.site(ORG, SITE), { name: 'My Site', created_at: '2026-01-01T00:00:00Z' });
  await store.setDoc(paths.deploy(ORG, SITE, JOB), {
    version_id: MAIN_VERSION_ID,
    environment: 'production',
    status: 'queued',
    started_at: new Date().toISOString(),
  });
}

async function readJob(): Promise<DeployJob | null> {
  const { getStore } = await import('../../lib/datastore');
  return getStore().getDoc<DeployJob>(paths.deploy(ORG, SITE, JOB));
}

const args = {
  jobId: JOB,
  orgId: ORG,
  siteId: SITE,
  versionId: MAIN_VERSION_ID,
  environment: 'production' as const,
};

describe('executeDeployJob cost accounting', () => {
  beforeEach(async () => {
    makeTmpFixtures();
    await resetDatastore();
    vi.resetModules();
    runDeployMock.mockReset();
    for (const k of Object.keys(process.env)) {
      if (k.startsWith('DEPLOY_COST_')) delete process.env[k];
    }
    await seedJob();
  });

  it('writes a cost row with phase timings and output size on success', async () => {
    runDeployMock.mockImplementation(async (a: { onPhase?: (p: string) => unknown }) => {
      await a.onPhase?.('building');
      await a.onPhase?.('uploading');
      return { buildDir: '/tmp/x', fixturesDir: '/tmp/f', outputBytes: 4096, outputFiles: 12 };
    });

    const { executeDeployJob } = await import('../../lib/deploy/queue');
    await executeDeployJob(args);

    const job = await readJob();
    expect(job?.status).toBe('succeeded');
    expect(job?.cost).toBeDefined();
    expect(job?.cost?.currency).toBe('USD');
    expect(job?.cost?.estimated).toBe(true);
    expect(job?.cost?.total).toBeGreaterThan(0);
    expect(job?.cost?.duration_s).toBeGreaterThanOrEqual(0);
    expect(job?.cost?.output_bytes).toBe(4096);
    expect(job?.cost?.output_files).toBe(12);
    expect(Object.keys(job?.cost?.phases ?? {})).toEqual(
      expect.arrayContaining(['building', 'uploading']),
    );
  });

  it('still writes a cost row when the build fails', async () => {
    runDeployMock.mockImplementation(async (a: { onPhase?: (p: string) => unknown }) => {
      await a.onPhase?.('building');
      throw new Error('astro build exited with code 1');
    });

    const { executeDeployJob } = await import('../../lib/deploy/queue');
    await executeDeployJob(args);

    const job = await readJob();
    expect(job?.status).toBe('failed');
    expect(job?.error).toContain('astro build exited');
    expect(job?.cost).toBeDefined();
    expect(job?.cost?.total).toBeGreaterThan(0);
    // No upload happened, so no output size — but the compute still counted.
    expect(job?.cost?.output_bytes).toBeUndefined();
    expect(job?.cost?.phases?.building).toBeGreaterThanOrEqual(0);
  });

  it('prices with the deployment-configured rate card, not the default', async () => {
    process.env.DEPLOY_COST_CURRENCY = 'EUR';
    process.env.DEPLOY_COST_CPU_PER_VCPU_SECOND = '1';
    process.env.DEPLOY_COST_MEM_PER_GIB_SECOND = '0';
    process.env.DEPLOY_COST_PER_REQUEST = '0';
    runDeployMock.mockResolvedValue({ buildDir: '/tmp/x', fixturesDir: '/tmp/f' });

    const { executeDeployJob } = await import('../../lib/deploy/queue');
    await executeDeployJob(args);

    const job = await readJob();
    expect(job?.cost?.currency).toBe('EUR');
    expect(job?.cost?.rates.cpu_per_vcpu_second).toBe(1);
    // At 1 unit per vCPU-second, cost equals duration — a self-check that the
    // configured card actually drove the math.
    expect(job?.cost?.total).toBeCloseTo(job?.cost?.duration_s ?? -1, 5);
  });

  it('reports a dry run as succeeded and still costs it', async () => {
    runDeployMock.mockResolvedValue({ buildDir: '/tmp/x', fixturesDir: '/tmp/f', outputBytes: 10 });

    const { executeDeployJob } = await import('../../lib/deploy/queue');
    await executeDeployJob({ ...args, dryRun: true });

    const job = await readJob();
    expect(job?.status).toBe('succeeded');
    expect((job as DeployJob & { dry_run?: boolean }).dry_run).toBe(true);
    expect(job?.cost?.total).toBeGreaterThan(0);
  });
});
