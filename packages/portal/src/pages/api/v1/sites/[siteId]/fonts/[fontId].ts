// GET    /api/v1/sites/{siteId}/fonts/{fontId}   — one library file → { font }
// DELETE /api/v1/sites/{siteId}/fonts/{fontId}   — remove it and its stored bytes
//        → { deleted: true, warning? } (warning names the roles that fall back)
//
// Deleting a family a role still uses is allowed; the role falls back at the
// next publication. Admin, like uploading.

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../lib/api-auth';
import { pathParam } from '../../../../../../lib/path-param';
import { deleteSiteFont, fontFailureBody, readSiteFont } from '../../../../../../lib/fonts/font-library';

export const GET: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const id = pathParam(params.fontId);
  if (!id) return apiError('Missing fontId', 400, ctx);
  const font = await readSiteFont(ctx.orgId, ctx.siteId, id);
  return font ? apiResponse(ctx, { font }) : apiError('Font not found', 404, ctx, { code: 'font_not_found' });
};

export const DELETE: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  if (ctx.permission !== 'admin') return apiError('Insufficient permission (admin required)', 403, ctx);
  const id = pathParam(params.fontId);
  if (!id) return apiError('Missing fontId', 400, ctx);
  try {
    return apiResponse(ctx, await deleteSiteFont(ctx.orgId, ctx.siteId, id));
  } catch (error) {
    const refused = fontFailureBody(error);
    if (!refused) throw error;
    return apiError(refused.body.error, refused.status, ctx, { code: refused.body.code });
  }
};
