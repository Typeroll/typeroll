// POST /api/v1/sites/{siteId}/deploy
//
// Enqueue a deploy of the currently-resolved version (main by default,
// or whatever ?version=<id> resolved to). Returns { job_id } immediately;
// the agent polls GET /v1/sites/{siteId}/deploys/{jobId} for status.
//
// Body (optional): { environment: "production" | "staging" }. Default
// production — staging is reserved for the platform's own internal-test
// environment and isn't usually relevant to customer sites.

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../lib/api-auth';
import { getStore } from '../../../../../lib/datastore';
import { getDeployQueue } from '../../../../../lib/deploy/queue';
import { paths } from '@typeroll/shared';
import type { DeployEnvironment } from '@typeroll/shared';
import { publishingReadiness } from '../../../../../lib/publishing/readiness';
import { privateJson } from '../../../../../lib/publishing/http';

export const POST: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  if (ctx.permission !== 'admin') return apiError('Publishing requires admin permission on the site.', 403);

  const body = (await request.json().catch(() => ({}))) as {
    environment?: DeployEnvironment;
    dry_run?: boolean;
  };
  const environment: DeployEnvironment = body.environment === 'staging' ? 'staging' : 'production';
  const dryRun = body.dry_run === true;
  if (!dryRun) {
    const readiness = await publishingReadiness(ctx.orgId, ctx.siteId, ctx.versionId);
    if (!readiness.ready) return privateJson({ error: 'Set up Publishing before deploying this site.', code: 'publishing_setup_required', required: readiness.required }, 409);
  }

  const store = getStore();
  const jobId = await store.addDoc(paths.deploys(ctx.orgId, ctx.siteId), {
    version_id: ctx.versionId,
    environment,
    status: 'queued',
    started_at: new Date().toISOString(),
    triggered_by: `api-key:${ctx.keyPrefix}`,
    dry_run: dryRun,
  });

  try {
    await getDeployQueue().enqueue({
      jobId,
      orgId: ctx.orgId,
      siteId: ctx.siteId,
      versionId: ctx.versionId,
      environment,
      dryRun,
    });
  } catch (e) {
    await store.updateDoc(paths.deploy(ctx.orgId, ctx.siteId, jobId), {
      status: 'failed',
      phase: 'enqueue_failed',
      finished_at: new Date().toISOString(),
      error: e instanceof Error ? e.message : String(e),
    });
    return apiError('Failed to enqueue deploy', 500);
  }

  return apiResponse(ctx, {
    job_id: jobId,
    version_id: ctx.versionId,
    environment,
    dry_run: dryRun,
  }, 202, body);
};
