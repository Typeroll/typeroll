import { unsavedPublicationTargets } from '../../../../../lib/deploy/unsaved';
import { retryPublicationVerification } from '../../../../../lib/publishing/verification-retry';
import { ConnectionError } from '../../../../../lib/publishing/connections';
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
import { apiError, apiResponse, requireApiKey, requireAnyApiKey } from '../../../../../lib/api-auth';
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
    allow_unsaved?: boolean; retry_verification_job_id?: string; approve_cache_zone_id?: string;
  };
  if (body.retry_verification_job_id !== undefined) {
    try {
      if (typeof body.retry_verification_job_id !== 'string' || body.dry_run === true) return privateJson({ error: 'Provide a deployment ID without dry_run.' }, 400);
      if (body.approve_cache_zone_id !== undefined) {
        if (typeof body.approve_cache_zone_id !== 'string' || !body.approve_cache_zone_id) return privateJson({ error: 'Provide the exact cache zone ID from the failed job.' }, 400);
        const org = await requireAnyApiKey(request);
        if (!org.ok) return org.response;
        if (org.value.tokenSiteId !== null || org.value.tokenOrgId !== ctx.orgId) return apiError('An administrator of the owning organization must approve a zone-wide cache refresh.', 403);
      }
      const result = await retryPublicationVerification(ctx.orgId, ctx.siteId, body.retry_verification_job_id, ctx.versionId, body.approve_cache_zone_id);
      const response = apiResponse(ctx, result, 202, body);
      response.headers.set('Cache-Control', 'private, no-store');
      return response;
    } catch (error) {
      return privateJson({ error: error instanceof ConnectionError ? error.message : 'Could not retry publication verification.', code: error instanceof ConnectionError ? error.code : 'verification_retry_failed' }, error instanceof ConnectionError ? error.status : 500);
    }
  }
  if (body.approve_cache_zone_id !== undefined) return privateJson({ error: 'Cache approval requires an existing failed deployment ID.' }, 400);
  const environment: DeployEnvironment = body.environment === 'staging' ? 'staging' : 'production';
  const dryRun = body.dry_run === true;
  if (!dryRun) {
    const readiness = await publishingReadiness(ctx.orgId, ctx.siteId, ctx.versionId);
    if (!readiness.ready) return privateJson({ error: 'Set up Publishing before deploying this site.', code: 'publishing_setup_required', required: readiness.required }, 409);
  }

  const store = getStore();

  const unsaved = await unsavedPublicationTargets(ctx.orgId, ctx.siteId, ctx.versionId);
  if (unsaved.length && body.allow_unsaved !== true) return privateJson({
    code: 'unsaved_content', error: 'Pages or shared blocks have unsaved edits. Save or discard them, or explicitly publish the saved content only.',
    unsaved, requires_confirmation: true,
  }, 409);

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
