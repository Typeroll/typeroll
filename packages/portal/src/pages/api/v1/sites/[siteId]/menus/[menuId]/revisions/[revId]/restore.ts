// POST /api/v1/sites/{siteId}/menus/{menuId}/revisions/{revId}/restore
//
// Saves a revision's name, locations, settings and items as the menu. Menus
// have no working copy, so the restore is a save: the menu as it was is kept
// as a revision first, which makes the restore undoable. A location that
// another menu fills now is refused with 409.

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../../../../lib/api-auth';
import { vstore } from '../../../../../../../../../lib/version-store';
import { getRevision } from '../../../../../../../../../lib/revisions';
import { MenuSaveError, restoreMenuRevision } from '../../../../../../../../../lib/menu-write';
import { pathParam } from '../../../../../../../../../lib/path-param';
import type { Menu } from '@typeroll/shared';

export const POST: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const menuId = pathParam(params.menuId);
  const revId = pathParam(params.revId);
  if (!menuId || !revId) return apiError('Missing menuId or revId', 400, ctx);
  if (!(await vstore.menu(ctx.orgId, ctx.siteId, ctx.versionId, menuId))) return apiError('Menu not found', 404, ctx);
  const rev = await getRevision({ orgId: ctx.orgId, siteId: ctx.siteId, versionId: ctx.versionId, kind: 'menu', resourceIds: [menuId], revId });
  if (!rev) return apiError('Revision not found', 404, ctx);
  try {
    const menu = await restoreMenuRevision(ctx, menuId, rev.doc as Partial<Menu>, revId, `api-key:${ctx.keyPrefix}`);
    return apiResponse(ctx, { restored_revision: revId, menu }, 200, {});
  } catch (error) {
    if (error instanceof MenuSaveError) return apiError(error.message, error.status, ctx, error.errors ? { details: { errors: error.errors } } : undefined);
    throw error;
  }
};
