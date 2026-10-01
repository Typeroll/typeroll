// GET  /api/v1/sites/{siteId}/shares — list cross-organization shares of the
//                                      site, revoked ones included for audit.
// POST /api/v1/sites/{siteId}/shares — share the site with another
//      organization. Body: { org_id? | org_slug?, permission?: 'read' | 'write' | 'admin', label? }.
//
// Admin on the site for both, exactly as the settings UI
// (/api/sites/{siteId}/shares). A grant never exceeds `admin`, which an admin
// caller already holds, so a key cannot hand out more than it has.

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../lib/api-auth';
import { createSiteShare, listSharesForSite } from '../../../../../../lib/shares';

const ADMIN_REQUIRED = 'Managing site sharing requires admin permission on the site.';

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
