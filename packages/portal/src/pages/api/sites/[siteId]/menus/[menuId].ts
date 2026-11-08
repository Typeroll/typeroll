// GET    /api/sites/{siteId}/menus/{menuId}
// PUT    /api/sites/{siteId}/menus/{menuId}   — replace the whole menu; send
//        `expected_updated_at` (the updated_at you loaded) to refuse a save
//        over someone else's, and `take_locations: true` to move a location
//        another menu fills to this one (the response lists `moved_locations`)
// DELETE /api/sites/{siteId}/menus/{menuId}

import type { APIRoute } from 'astro';
import { requireSiteAccess, json, requirePermission } from '../../../../../lib/access';
import { vstore } from '../../../../../lib/version-store';
import { MenuSaveError, removeMenu, replaceMenuMovingLocations, takeLocationsFlag } from '../../../../../lib/menu-write';
import { pathParam } from '../../../../../lib/path-param';

function failure(error: unknown): Response {
  if (error instanceof MenuSaveError) return json({ error: error.message, ...(error.errors ? { errors: error.errors } : {}) }, error.status);
  throw error;
}

export const GET: APIRoute = async ({ cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const { site, versionId, owner_org_id } = guard.value;
  const menuId = pathParam(params.menuId);
  if (!menuId) return json({ error: 'Missing menuId' }, 400);
  const menu = await vstore.menu(owner_org_id, site.id, versionId, menuId);
  if (!menu) return json({ error: 'Not found' }, 404);
  return json({ menu });
};

export const PUT: APIRoute = async ({ request, cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const writeCheck = requirePermission(guard.value, 'write');
  if (!writeCheck.ok) return writeCheck.response;
  const { session, site, versionId, owner_org_id } = guard.value;
  const menuId = pathParam(params.menuId);
  if (!menuId) return json({ error: 'Missing menuId' }, 400);
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'Invalid JSON body' }, 400);
  const { expected_updated_at: expected, ...menu } = body;
  if (expected !== undefined && typeof expected !== 'string') return json({ error: 'expected_updated_at must be a string' }, 400);
  try {
    const saved = await replaceMenuMovingLocations({ orgId: owner_org_id, siteId: site.id, versionId }, menuId, menu,
      { updatedBy: session.email ?? 'unknown', expectedUpdatedAt: expected, takeLocations: takeLocationsFlag(menu) });
    return json(saved);
  } catch (error) { return failure(error); }
};

export const DELETE: APIRoute = async ({ cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const writeCheck = requirePermission(guard.value, 'write');
  if (!writeCheck.ok) return writeCheck.response;
  const { site, versionId, owner_org_id } = guard.value;
  const menuId = pathParam(params.menuId);
  if (!menuId) return json({ error: 'Missing menuId' }, 400);
  try {
    await removeMenu({ orgId: owner_org_id, siteId: site.id, versionId }, menuId);
    return json({ ok: true });
  } catch (error) { return failure(error); }
};
