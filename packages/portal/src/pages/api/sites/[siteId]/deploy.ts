// Deploy entry point.
//
// Creates a DeployJob doc, hands the work to the configured DeployQueue,
// returns the job id. The client polls GET /api/sites/{id}/deploys/{jobId}
// for progress.
//
// The actual deploy runs in a separate context:
//   - Local dev / in-process: fire-and-forget Promise (DeployQueue
//     implementation = InProcessQueue).
//   - Staging / production: Cloud Tasks enqueues a request to
//     POST /api/internal/deploy-worker (DeployQueue = CloudTasksQueue).
//
// Either way, the job doc is the source of truth for status. Consumers
// (poll route, dashboard, deploy button) don't care which mode is active.

import type { APIRoute } from 'astro';
import { requireSiteAccess, json, requirePermission } from '../../../../lib/access';
import { getStore } from '../../../../lib/datastore';
import { getDeployQueue } from '../../../../lib/deploy/queue';
import { findActiveDeploy } from '../../../../lib/deploy/in-flight';
import { paths } from '@typeroll/shared';
import type { DeployEnvironment, DeployJob } from '@typeroll/shared';

export const POST: APIRoute = async ({ cookies, params, request, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const adminCheck = requirePermission(guard.value, 'admin');
  if (!adminCheck.ok) return adminCheck.response;
  const { session, site, versionId, owner_org_id } = guard.value;

  const body = (await request.json().catch(() => ({}))) as { environment?: DeployEnvironment };
  const environment: DeployEnvironment = body.environment === 'staging' ? 'staging' : 'production';

  const store = getStore();

  // Already building? Hand back the running job instead of starting a second
  // one. Both builds would upload to the same Cloudflare Pages project, so the
  // last to FINISH wins — which is not necessarily the newest content.
  //
  // 200 with the existing id rather than a 409: the client's next move is to
  // poll the job either way, and a double-click should feel like one deploy,
  // not like an error.
  try {
    const existing = findActiveDeploy(
      await store.listDocs<DeployJob>(paths.deploys(owner_org_id, site.id)),
    );
    if (existing) {
      return json({ job_id: existing.id, already_running: true });
    }
  } catch {
    // A site with no deploys yet has no collection. Not a reason to refuse.
  }

  const jobId = await store.addDoc(paths.deploys(owner_org_id, site.id), {
    version_id: versionId,
    environment,
    status: 'queued',
    started_at: new Date().toISOString(),
    triggered_by: session.email ?? session.userId ?? 'unknown',
  });

  try {
    await getDeployQueue().enqueue({
      jobId,
      orgId: owner_org_id,
      siteId: site.id,
      versionId,
      environment,
    });
  } catch (e) {
    // If enqueueing itself fails (Cloud Tasks unreachable, misconfig), mark
    // the job as failed so the poller surfaces it rather than spinning
    // forever in 'queued'.
    await store.updateDoc(paths.deploy(owner_org_id, site.id, jobId), {
      status: 'failed',
      phase: 'enqueue_failed',
      finished_at: new Date().toISOString(),
      error: e instanceof Error ? e.message : String(e),
    });
    return json({ error: 'Failed to enqueue deploy', detail: e instanceof Error ? e.message : 'unknown' }, 500);
  }

  return json({ ok: true, jobId });
};

/** Most recent deploy jobs for the site, newest first. Lightweight — just
 *  enough for the dashboard to show "last deploy: 3 min ago, succeeded". */
export const GET: APIRoute = async ({ cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const { session, site, owner_org_id } = guard.value;

  const store = getStore();
  const all = await store.listDocs<DeployJob>(paths.deploys(owner_org_id, site.id));
  const sorted = all
    .sort((a, b) => (b.started_at ?? '').localeCompare(a.started_at ?? ''))
    .slice(0, 20);
  return json({ jobs: sorted });
};
