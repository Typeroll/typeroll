// Regression: deploy-worker dropped the `dryRun` field from the task
// payload, turning every agent's `trigger_deploy dry_run=true` into a
// real production deploy. This test pins the worker contract: the
// payload Type carries dryRun, and the worker forwards it to
// executeDeployJob.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { MAIN_VERSION_ID, paths } from '@typeroll/shared';
import type { APIRoute } from 'astro';
import type { DeployJob, Site, SiteVersion } from '@typeroll/shared';

const ORG = 'orgone';
const SITE = 'mysite';

async function setup(): Promise<{ jobId: string }> {
  makeTmpFixtures();
  await resetDatastore();
  vi.resetModules();
  process.env.DEPLOY_WORKER_SKIP_AUTH = '1';
  const { getStore } = await import('../../lib/datastore');
  await getStore().setDoc(paths.site(ORG, SITE), {
    name: 'My Site', created_at: new Date().toISOString(),
  } satisfies Partial<Site>);
  await getStore().setDoc(paths.version(ORG, SITE, MAIN_VERSION_ID), {
    name: 'Main', kind: 'main', created_at: new Date().toISOString(), robots_blocked: false,
  } satisfies Partial<SiteVersion>);
  const jobId = await getStore().addDoc(paths.deploys(ORG, SITE), {
    version_id: MAIN_VERSION_ID,
    environment: 'production',
    status: 'queued',
    started_at: new Date().toISOString(),
    triggered_by: 'test',
    dry_run: true,
  });
  return { jobId };
}

describe('deploy-worker forwards dryRun', () => {
  beforeEach(async () => { await resetDatastore(); });

  it.each(['customer_git', 'organization_cloudflare', 'organization_github'] as const)('continues a running %s job and preserves retries', async execution_backend => {
    const { jobId } = await setup();
    const { getStore } = await import('../../lib/datastore');
    await getStore().updateDoc(paths.deploy(ORG, SITE, jobId), { status: 'running', execution_backend });
    const execute = vi.fn(async () => 'deferred'), enqueue = vi.fn(async (_args: any) => {});
    vi.doMock('../../lib/deploy/queue', () => ({ executeDeployJob: execute, getDeployQueue: () => ({ enqueue }) }));
    const { POST } = await import('../../pages/api/internal/deploy-worker');
    const request = new Request('http://localhost/api/internal/deploy-worker', { method: 'POST', body: JSON.stringify({ jobId, orgId: ORG, siteId: SITE, versionId: MAIN_VERSION_ID, environment: 'production' }) });
    const response = await POST({ request } as never) as Response;
    expect(response.status).toBe(200);
    expect(execute).toHaveBeenCalledOnce();
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ jobId, orgId: ORG, siteId: SITE, versionId: MAIN_VERSION_ID, delayMs: 60000 }));
    const first = enqueue.mock.calls[0][0];
    const duplicate = new Request('http://localhost/api/internal/deploy-worker', { method: 'POST', body: JSON.stringify({ jobId, orgId: ORG, siteId: SITE, versionId: MAIN_VERSION_ID, environment: 'production' }) });
    expect((await POST({ request: duplicate } as never) as Response).status).toBe(200);
    expect(enqueue.mock.calls[1][0].dispatchKey).toBe(first.dispatchKey);
    enqueue.mockRejectedValueOnce(new Error('queue unavailable'));
    const unavailable = new Request('http://localhost/api/internal/deploy-worker', { method: 'POST', body: JSON.stringify({ ...first, dryRun: true }) });
    expect((await POST({ request: unavailable } as never) as Response).status).toBe(503);
    expect(enqueue.mock.calls[2][0]).toMatchObject({ dryRun: true });
    expect(enqueue.mock.calls[2][0].dispatchKey).not.toBe(first.dispatchKey);
  });

  it('passes payload.dryRun through to executeDeployJob', async () => {
    const { jobId } = await setup();
    const seen: { dryRun?: boolean } = {};
    vi.doMock('../../lib/deploy/queue', async () => {
      const actual = await vi.importActual<typeof import('../../lib/deploy/queue')>('../../lib/deploy/queue');
      return {
        ...actual,
        executeDeployJob: vi.fn(async (args: { dryRun?: boolean }) => {
          seen.dryRun = args.dryRun;
          return 'ran';
        }),
      };
    });

    const mod = await import('../../pages/api/internal/deploy-worker');
    const req = new Request('http://localhost/api/internal/deploy-worker', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jobId, orgId: ORG, siteId: SITE, versionId: MAIN_VERSION_ID,
        environment: 'production',
        dryRun: true,
      }),
    });
    const res = await (mod.POST as APIRoute)({ request: req } as never) as Response;
    expect(res.status).toBe(200);
    expect(seen.dryRun).toBe(true);
  });

  it('defaults dryRun to false when missing from payload', async () => {
    const { jobId } = await setup();
    const seen: { dryRun?: boolean } = {};
    vi.doMock('../../lib/deploy/queue', async () => {
      const actual = await vi.importActual<typeof import('../../lib/deploy/queue')>('../../lib/deploy/queue');
      return {
        ...actual,
        executeDeployJob: vi.fn(async (args: { dryRun?: boolean }) => {
          seen.dryRun = args.dryRun;
          return 'ran';
        }),
      };
    });

    const mod = await import('../../pages/api/internal/deploy-worker');
    const req = new Request('http://localhost/api/internal/deploy-worker', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jobId, orgId: ORG, siteId: SITE, versionId: MAIN_VERSION_ID,
        environment: 'production',
      }),
    });
    const res = await (mod.POST as APIRoute)({ request: req } as never) as Response;
    expect(res.status).toBe(200);
    expect(seen.dryRun).toBe(false);
  });
});

// Note: end-to-end test that executeDeployJob actually passes
// buildOnly=true to runDeploy lives implicitly in the smoke build —
// running runDeploy here would spawn astro and download dependencies.
// The two worker tests above are what pin the regression that broke
// 0.7.0: the field round-trips through Cloud Tasks → worker → queue.
