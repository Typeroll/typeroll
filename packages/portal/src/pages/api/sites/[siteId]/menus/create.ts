// POST /api/sites/{siteId}/menus/create
//
// Creates an empty menu from the portal's "New menu" form (field `name`,
// optional `location`) and opens it in the menu editor. JSON callers use
// POST /api/sites/{siteId}/menus instead.

import type { APIRoute } from 'astro';
import { requireSiteAccess, json, requirePermission } from '../../../../../lib/access';
import { createMenu, MenuSaveError } from '../../../../../lib/menu-write';

export const POST: APIRoute = async ({ request, cookies, params, redirect, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const writeCheck = requirePermission(guard.value, 'write');
  if (!writeCheck.ok) return writeCheck.response;
  const { site, versionId, owner_org_id } = guard.value;

  const form = await request.formData();
  const name = String(form.get('name') ?? '').trim();
  if (!name) return json({ error: 'Name required' }, 400);
  const location = String(form.get('location') ?? '').trim();
  try {
    const menu = await createMenu({ orgId: owner_org_id, siteId: site.id, versionId }, { name, items: [], ...(location ? { locations: [location] } : {}) });
    return redirect(`/app/sites/${site.id}/menus/${menu.id}`);
  } catch (error) {
    if (error instanceof MenuSaveError) return json({ error: error.message }, error.status);
    throw error;
  }
};
