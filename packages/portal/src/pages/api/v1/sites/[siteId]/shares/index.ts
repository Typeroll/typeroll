// GET  /api/v1/sites/{siteId}/shares — list cross-organization shares of the
//                                      site, revoked ones included for audit.
// POST /api/v1/sites/{siteId}/shares — share the site with another
//      organization. Body: { org_id? | org_slug?, permission?: 'read' | 'write' | 'admin', label? }.
//
// Admin on the site for both, exactly as the settings UI
// (/api/sites/{siteId}/shares). Granting is reserved to the owning
// organization: a caller that reaches the site through a share cannot pass it
// on, and an Extension installation credential never manages sharing.

import type { APIRoute } from 'astro';
import { apiError, apiResponse, isApiSiteOwner, requireApiKey } from '../../../../../../lib/api-auth';
import { createSiteShare, listSharesForSite } from '../../../../../../lib/shares';

const ADMIN_REQUIRED = 'Managing site sharing requires admin permission on the site.';
const OWNER_REQUIRED = 'Only the owning organization can share this site.';

export const GET: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  if (ctx.permission !== 'admin') return apiError(ADMIN_REQUIRED, 403, ctx);
  return apiResponse(ctx, { shares: await listSharesForSite(ctx.orgId, ctx.siteId) });
};

export const POST: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  if (ctx.permission !== 'admin') return apiError(ADMIN_REQUIRED, 403, ctx);
  if (!isApiSiteOwner(ctx)) return apiError(OWNER_REQUIRED, 403, ctx);

  let body: unknown;
  try { body = await request.json(); } catch { return apiError('Invalid JSON body. Expected { org_id | org_slug, permission?, label? }.', 400, ctx); }
  const result = await createSiteShare({
    ownerOrgId: ctx.orgId,
    siteId: ctx.siteId,
    createdBy: `api-key:${ctx.keyPrefix}`,
    body,
  });
  if (!result.ok) return apiError(result.error, result.status, ctx);
  return apiResponse(ctx, { share: result.share }, 201, body);
};
