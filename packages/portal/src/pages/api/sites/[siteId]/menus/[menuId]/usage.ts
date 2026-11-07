// GET /api/sites/{siteId}/menus/{menuId}/usage
//
// Pages, page templates and partials that show this menu (by id or by one of
// its locations), saved or in a draft. Used by the menu editor.

import type { APIRoute } from 'astro';
import { requireSiteAccess, json } from '../../../../../../lib/access';
import { getMenuUsage } from '../../../../../../lib/menu-usage';
import { vstore } from '../../../../../../lib/version-store';
import { pathParam } from '../../../../../../lib/path-param';

export const GET: APIRoute = async ({ cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const { site, versionId, owner_org_id } = guard.value;
  const menuId = pathParam(params.menuId);
  if (!menuId) return json({ error: 'Missing menuId' }, 400);
  const menu = await vstore.menu(owner_org_id, site.id, versionId, menuId);
  if (!menu) return json({ error: 'Not found' }, 404);
  const usage = await getMenuUsage(owner_org_id, site.id, versionId, menuId);
  return json({ menu_id: menuId, locations: menu.locations ?? [], ...usage });
};
