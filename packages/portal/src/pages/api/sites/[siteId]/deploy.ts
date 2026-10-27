import { unsavedPublicationTargets } from '../../../../lib/deploy/unsaved';
import { retryPublicationVerification } from '../../../../lib/publishing/verification-retry';
import { ConnectionError } from '../../../../lib/publishing/connections';
// Deploy entry point.
//
// Creates a DeployJob doc, hands the work to the configured DeployQueue,
// returns the job id. The client polls GET /api/sites/{id}/deploys/{jobId}
// for progress.
//
// The actual deploy runs in a separate context:
//   - Local dev / in-process: fire-and-forget Promise (DeployQueue
//     implementation = InProcessQueue).
//   - Self-host production: Firestore queue consumed by SERVICE_ROLE=worker.
//   - Typeroll Cloud: Cloud Tasks enqueues a request to
//     POST /api/internal/deploy-worker (DeployQueue = CloudTasksQueue).
//
// Either way, the job doc is the source of truth for status. Consumers
// (poll route, dashboard, deploy button) don't care which mode is active.

import type { APIRoute } from 'astro';
import { requireSiteAccess, json, requirePermission, requireOrganizationOwnerOrAdmin } from '../../../../lib/access';
import { getStore } from '../../../../lib/datastore';
import { getDeployQueue } from '../../../../lib/deploy/queue';
import { findActiveDeploy, isDomainPreparation } from '../../../../lib/deploy/in-flight';
import { paths } from '@typeroll/shared';
import type { DeployEnvironment, DeployJob } from '@typeroll/shared';
import { refreshDeploymentAvailability } from '../../../../lib/deploy/availability';
import { publishingReadiness } from '../../../../lib/publishing/readiness';

export const POST: APIRoute = async ({ cookies, params, request, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const adminCheck = requirePermission(guard.value, 'admin');
  if (!adminCheck.ok) return adminCheck.response;
  const { session, site, versionId, owner_org_id } = guard.value;

  const body = (await request.json().catch(() => ({}))) as { environment?: DeployEnvironment; allow_unsaved?: boolean; retry_verification_job_id?: string; approve_cache_zone_id?: string };
  if (body.retry_verification_job_id !== undefined) {
    try {
      if (typeof body.retry_verification_job_id !== 'string') return json({ error: 'Provide a deployment ID.' }, 400);
      if (body.approve_cache_zone_id !== undefined) {
        if (typeof body.approve_cache_zone_id !== 'string' || !body.approve_cache_zone_id) return json({ error: 'Provide the exact cache zone ID from the failed job.' }, 400);
        const org = await requireOrganizationOwnerOrAdmin(cookies, 'An organization administrator must approve a zone-wide cache refresh.');
        if (!org.ok) return org.response;
        if (org.value.orgId !== owner_org_id) return json({ error: 'Only the owning organization can refresh this domain zone.' }, 403);
      }
      return json(await retryPublicationVerification(owner_org_id, site.id, body.retry_verification_job_id, versionId, body.approve_cache_zone_id), 202);
    } catch (error) {
      return json({ error: error instanceof ConnectionError ? error.message : 'Could not retry publication verification.', code: error instanceof ConnectionError ? error.code : 'verification_retry_failed' }, error instanceof ConnectionError ? error.status : 500);
    }
  }
  if (body.approve_cache_zone_id !== undefined) return json({ error: 'Cache approval requires an existing failed deployment ID.' }, 400);
  const environment: DeployEnvironment = body.environment === 'staging' ? 'staging' : 'production';

  const store = getStore();
  const readiness = await publishingReadiness(owner_org_id, site.id, versionId);
  if (!readiness.ready) return json({ error: 'Set up Publishing before deploying this site.', code: 'publishing_setup_required', required: readiness.required }, 409);

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


  const unsaved = await unsavedPublicationTargets(owner_org_id, site.id, versionId);
  if (unsaved.length && body.allow_unsaved !== true) return json({
    code: 'unsaved_content', error: 'Pages or shared blocks have unsaved edits. Save or discard them, or explicitly publish the saved content only.',
    unsaved, requires_confirmation: true,
  }, 409);

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
  const { site, owner_org_id, versionId } = guard.value;

  const store = getStore();
  const all = await store.listDocs<DeployJob>(paths.deploys(owner_org_id, site.id));
  const sorted = all
    .sort((a, b) => (b.started_at ?? '').localeCompare(a.started_at ?? ''))
    .slice(0, 20);
  const jobs = await Promise.all(sorted.map(job => refreshDeploymentAvailability(owner_org_id, site.id, job)));
  // Return a job that completed during this request too: the already-rendered
  // page may still have hidden links and must refresh once to show them.
  const resumed = all.find(job => job.version_id === versionId && !isDomainPreparation(job) && ['queued', 'running'].includes(job.status));
  const latest = all.find(job => job.version_id === versionId && !isDomainPreparation(job));
  const latestJob = latest ? jobs.find(job => job.id === latest.id) ?? await refreshDeploymentAvailability(owner_org_id, site.id, latest) : null;
  const activeJob = resumed ? jobs.find(job => job.id === resumed.id) ?? (resumed.id === latestJob?.id ? latestJob : await refreshDeploymentAvailability(owner_org_id, site.id, resumed)) : null;
  return json({ jobs, active_job: activeJob, latest_job: latestJob });
};
