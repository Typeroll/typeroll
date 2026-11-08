// GET  /api/v1/sites/{siteId}/menus   — every menu of the version
// POST /api/v1/sites/{siteId}/menus   — create a menu
//   body: { id?, name, locations?, auto_add_pages?, items, take_locations? }
//
// Menus are saved directly (no working copy) and reach the live site with
// the next publication. Without an id one is derived from the name. A
// location another menu already fills is refused with 409, unless
// `take_locations: true` moves it to the new menu (the other menu keeps its
// items); the response lists such moves in `moved_locations`.

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../lib/api-auth';
import { vstore } from '../../../../../../lib/version-store';
import { createMenuMovingLocations, MenuSaveError, takeLocationsFlag } from '../../../../../../lib/menu-write';

export const GET: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const menus = await vstore.menus(ctx.orgId, ctx.siteId, ctx.versionId);
  menus.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return apiResponse(ctx, { menus });
};

export const POST: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const body = await request.json().catch(() => null);
  if (!body) return apiError('Invalid JSON body', 400, ctx);
  try {
    const saved = await createMenuMovingLocations(ctx, body, { takeLocations: takeLocationsFlag(body), updatedBy: `api-key:${ctx.keyPrefix}` });
    return apiResponse(ctx, saved, 201, body);
  } catch (error) {
    if (error instanceof MenuSaveError) return apiError(error.message, error.status, ctx, error.errors ? { details: { errors: error.errors } } : undefined);
    throw error;
  }
};
