// POST /api/v1/sites/{siteId}/domain/activate — flip verified → live.
//
// Body: { auto_deploy?: boolean } — defaults to true. Triggers a
// production deploy so canonical URLs update in the next build.

import type { APIRoute } from 'astro';
import { MAIN_VERSION_ID, paths } from '@typeroll/shared';
import { requireApiKey, apiResponse, apiError } from '../../../../../../lib/api-auth';
import { activateDomain, DomainServiceError } from '../../../../../../lib/site-domain';
import { getStore } from '../../../../../../lib/datastore';
import { getDeployQueue } from '../../../../../../lib/deploy/queue';

export const POST: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  if (ctx.permission !== 'admin') {
    return apiError('Domain management requires admin permission on the site.', 403);
  }

  const body = (await request.json().catch(() => ({}))) as { auto_deploy?: boolean };
  const autoDeploy = body.auto_deploy !== false;

  try {
    const state = await activateDomain(ctx.orgId, ctx.siteId);

    let deployJobId: string | undefined;
    if (autoDeploy) {
      try {
        const store = getStore();
        deployJobId = await store.addDoc(paths.deploys(ctx.orgId, ctx.siteId), {
          version_id: MAIN_VERSION_ID,
          environment: 'production',
          status: 'queued',
          started_at: new Date().toISOString(),
          triggered_by: `api-key:${ctx.keyPrefix}`,
          source: 'domain-activate',
        });
        await getDeployQueue().enqueue({
          jobId: deployJobId,
          orgId: ctx.orgId,
          siteId: ctx.siteId,
          versionId: MAIN_VERSION_ID,
          environment: 'production',
        });
      } catch (e) {
        return apiResponse(ctx, {
          domain: state,
          deploy: { error: e instanceof Error ? e.message : String(e) },
        });
      }
    }

    return apiResponse(ctx, {
      domain: state,
      ...(deployJobId ? { deploy: { job_id: deployJobId } } : {}),
    });
  } catch (e) {
    if (e instanceof DomainServiceError) return apiError(e.message, e.status);
    return apiError(e instanceof Error ? e.message : String(e), 500);
  }
};
