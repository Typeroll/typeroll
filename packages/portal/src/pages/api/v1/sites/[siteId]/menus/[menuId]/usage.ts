// GET /api/v1/sites/{siteId}/menus/{menuId}/usage
//
// Pages, page templates and partials that show this menu through a
// navigation_links block with source "menu", by id or by one of the menu's
// locations (`location:primary`), saved or in a draft.

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../../lib/api-auth';
import { getMenuUsage } from '../../../../../../../lib/menu-usage';
import { vstore } from '../../../../../../../lib/version-store';
import { pathParam } from '../../../../../../../lib/path-param';

export const GET: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const menuId = pathParam(params.menuId);
  if (!menuId) return apiError('Missing menuId', 400, ctx);
  const menu = await vstore.menu(ctx.orgId, ctx.siteId, ctx.versionId, menuId);
  if (!menu) return apiError('Menu not found', 404, ctx);
  const usage = await getMenuUsage(ctx.orgId, ctx.siteId, ctx.versionId, menuId);
  return apiResponse(ctx, { menu_id: menuId, locations: menu.locations ?? [], ...usage });
};
