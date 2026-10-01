// PATCH  /api/v1/sites/{siteId}/shares/{shareId} — change permission and/or label.
// DELETE /api/v1/sites/{siteId}/shares/{shareId} — revoke the share. The
//        canonical record keeps revoked_at for audit; access ends immediately.
//
// Admin on the site, as in the settings UI (/api/sites/{siteId}/shares/{shareId}).

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../lib/api-auth';
import { parseShareUpdate, revokeShare, updateShare } from '../../../../../../lib/shares';

const ADMIN_REQUIRED = 'Managing site sharing requires admin permission on the site.';
const SHARE_ID = /^[A-Za-z0-9_-]{1,128}$/;

export const PATCH: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  if (ctx.permission !== 'admin') return apiError(ADMIN_REQUIRED, 403, ctx);
  if (!params.shareId || !SHARE_ID.test(params.shareId)) return apiError('Share not found', 404, ctx);

  let body: unknown;
  try { body = await request.json(); } catch { return apiError('Invalid JSON body. Expected { permission?, label? }.', 400, ctx); }
  const patch = parseShareUpdate(body);
  if ('error' in patch) return apiError(patch.error, 400, ctx);
  const updated = await updateShare(ctx.orgId, ctx.siteId, params.shareId, patch);
  if (!updated) return apiError('Share not found', 404, ctx);
  return apiResponse(ctx, { share: updated }, 200, body);
};

export const DELETE: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  if (ctx.permission !== 'admin') return apiError(ADMIN_REQUIRED, 403, ctx);
  if (!params.shareId || !SHARE_ID.test(params.shareId)) return apiError('Share not found', 404, ctx);
  const result = await revokeShare(ctx.orgId, ctx.siteId, params.shareId);
  if (!result) return apiError('Share not found', 404, ctx);
  return apiResponse(ctx, { ok: true, share: result });
};
