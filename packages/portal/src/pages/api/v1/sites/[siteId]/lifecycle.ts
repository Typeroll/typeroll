// GET  /api/v1/sites/{siteId}/lifecycle  — current lifecycle state
// POST /api/v1/sites/{siteId}/lifecycle  — { action: 'archive' | 'restore', reason? }
//
// Same rules as the portal's Settings → Archive site (lib/site-lifecycle.ts):
// owner-organization admins only, idempotent, and archiving is refused while a
// live custom domain still serves the site. An archived site refuses every
// other write; this route is let through so the site can be restored.

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey, requireApiSiteLifecycleChange } from '../../../../../lib/api-auth';
import { changeSiteLifecycle, siteLifecycleState } from '../../../../../lib/site-lifecycle';

export const GET: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  return apiResponse(ctx, { site: ctx.siteId, ...siteLifecycleState(ctx.site) });
};

export const POST: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId, { allowArchivedWrites: true });
  if (!guard.ok) return guard.response;
  const allowed = requireApiSiteLifecycleChange(guard.value);
  if (!allowed.ok) return allowed.response;
  const ctx = allowed.value;
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return apiError('Invalid JSON body', 400, ctx);

  const outcome = await changeSiteLifecycle({
    ownerOrgId: ctx.orgId,
    site: ctx.site,
    action: body.action,
    reason: body.reason,
    actor: `api-key:${ctx.keyPrefix}`,
  });
  return apiResponse(ctx, outcome.body, outcome.status, body);
};
