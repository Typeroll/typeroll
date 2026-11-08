// GET    /api/v1/sites/{siteId}/menus/{menuId}
// PUT    /api/v1/sites/{siteId}/menus/{menuId}   — replace the whole menu
//   body: { name, locations?, auto_add_pages?, items, expected_updated_at?, take_locations? }
// DELETE /api/v1/sites/{siteId}/menus/{menuId}
//
// PUT is revision checked: send the `updated_at` you read as
// `expected_updated_at` and the save is refused with 409 when the menu was
// saved in between. Every save keeps the previous menu as a revision.

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../lib/api-auth';
import { vstore } from '../../../../../../lib/version-store';
import { MenuSaveError, removeMenu, replaceMenuMovingLocations, takeLocationsFlag } from '../../../../../../lib/menu-write';
import { pathParam } from '../../../../../../lib/path-param';

function failure(error: unknown, ctx: { orgId: string; siteId: string }): Response {
  if (error instanceof MenuSaveError) return apiError(error.message, error.status, ctx, error.errors ? { details: { errors: error.errors } } : undefined);
  throw error;
}

export const GET: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const menuId = pathParam(params.menuId);
  if (!menuId) return apiError('Missing menuId', 400, ctx);
  const menu = await vstore.menu(ctx.orgId, ctx.siteId, ctx.versionId, menuId);
  if (!menu) return apiError('Menu not found', 404, ctx);
  return apiResponse(ctx, { menu });
};

export const PUT: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const menuId = pathParam(params.menuId);
  if (!menuId) return apiError('Missing menuId', 400, ctx);
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return apiError('Invalid JSON body', 400, ctx);
  const { expected_updated_at: expected, ...menu } = body;
  if (expected !== undefined && typeof expected !== 'string') return apiError('expected_updated_at must be the updated_at string you read', 400, ctx);
  try {
    const saved = await replaceMenuMovingLocations(ctx, menuId, menu, { updatedBy: `api-key:${ctx.keyPrefix}`, expectedUpdatedAt: expected, takeLocations: takeLocationsFlag(menu) });
    return apiResponse(ctx, saved, 200, body);
  } catch (error) { return failure(error, ctx); }
};

export const DELETE: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const menuId = pathParam(params.menuId);
  if (!menuId) return apiError('Missing menuId', 400, ctx);
  try {
    await removeMenu(ctx, menuId);
    return apiResponse(ctx, { ok: true });
  } catch (error) { return failure(error, ctx); }
};
