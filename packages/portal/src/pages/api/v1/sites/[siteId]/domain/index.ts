// Public-API mirror of /api/sites/{siteId}/domain — bearer-token auth.
// Used by MCP tools and direct API consumers.
//
// Admin-only on the share permission level; site-scoped keys are
// implicitly admin, org-scoped keys forward the share's permission.
// Lifecycle docs in docs/domain-lifecycle-plan.md.

import type { APIRoute } from 'astro';
import { MAIN_VERSION_ID, paths } from '@typeroll/shared';
import { requireApiKey, apiResponse, apiError } from '../../../../../../lib/api-auth';
import {
  requestDomain,
  removeDomain,
  getDomainState,
  DomainServiceError,
} from '../../../../../../lib/site-domain';
import { getStore } from '../../../../../../lib/datastore';
import { getDeployQueue } from '../../../../../../lib/deploy/queue';

function fail(e: unknown): Response {
  if (e instanceof DomainServiceError) return apiError(e.message, e.status);
  return apiError(e instanceof Error ? e.message : String(e), 500);
}

export const GET: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  try {
    const state = await getDomainState(ctx.orgId, ctx.siteId);
    return apiResponse(ctx, { domain: state });
  } catch (e) {
    return fail(e);
  }
};

export const POST: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  if (ctx.permission !== 'admin') {
    return apiError('Domain management requires admin permission on the site.', 403);
  }

  const body = (await request.json().catch(() => null)) as {
    hostname?: string;
    prefer?: 'apex' | 'www';
    auto_deploy?: boolean;
  } | null;
  if (!body?.hostname || typeof body.hostname !== 'string') {
    return apiError('hostname is required', 400);
  }
  try {
    const prefer = body.prefer === 'www' ? 'www' : 'apex';
    const state = await requestDomain(ctx.orgId, ctx.siteId, body.hostname, { prefer });
    let deployJobId: string | undefined;
    if (body.auto_deploy !== false) {
      try {
        const store = getStore();
        deployJobId = await store.addDoc(paths.deploys(ctx.orgId, ctx.siteId), {
          version_id: MAIN_VERSION_ID,
          environment: 'production',
          status: 'queued',
          started_at: new Date().toISOString(),
          triggered_by: `api-key:${ctx.keyPrefix}`,
          source: 'domain-declare',
        });
        await getDeployQueue().enqueue({
          jobId: deployJobId,
          orgId: ctx.orgId,
          siteId: ctx.siteId,
          versionId: MAIN_VERSION_ID,
          environment: 'production',
        });
      } catch (error) {
        return apiResponse(ctx, {
          domain: state,
          deploy: { error: error instanceof Error ? error.message : String(error) },
        });
      }
    }
    return apiResponse(
      ctx,
      { domain: state, ...(deployJobId ? { deploy: { job_id: deployJobId } } : {}) },
      200,
      { hostname: body.hostname, prefer, auto_deploy: body.auto_deploy !== false },
    );
  } catch (e) {
    return fail(e);
  }
};

export const DELETE: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  if (ctx.permission !== 'admin') {
    return apiError('Domain management requires admin permission on the site.', 403);
  }
  try {
    await removeDomain(ctx.orgId, ctx.siteId);
    return apiResponse(ctx, { ok: true });
  } catch (e) {
    return fail(e);
  }
};
