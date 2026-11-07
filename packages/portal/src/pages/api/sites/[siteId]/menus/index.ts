// GET  /api/sites/{siteId}/menus   — the version's menus, for the portal's menu editor
// POST /api/sites/{siteId}/menus   — create a menu (JSON: { id?, name, locations?, auto_add_pages?, items? })

import type { APIRoute } from 'astro';
import { requireSiteAccess, json, requirePermission } from '../../../../../lib/access';
import { vstore } from '../../../../../lib/version-store';
import { createMenu, MenuSaveError } from '../../../../../lib/menu-write';

export const GET: APIRoute = async ({ cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const { site, versionId, owner_org_id } = guard.value;
  const menus = await vstore.menus(owner_org_id, site.id, versionId);
  menus.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return json({ menus });
};

export const POST: APIRoute = async ({ request, cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const writeCheck = requirePermission(guard.value, 'write');
  if (!writeCheck.ok) return writeCheck.response;
  const { site, versionId, owner_org_id } = guard.value;
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return json({ error: 'Invalid JSON body' }, 400);
  try {
    const menu = await createMenu({ orgId: owner_org_id, siteId: site.id, versionId }, { items: [], ...body });
    return json({ menu }, 201);
  } catch (error) {
    if (error instanceof MenuSaveError) return json({ error: error.message, ...(error.errors ? { errors: error.errors } : {}) }, error.status);
    throw error;
  }
};
