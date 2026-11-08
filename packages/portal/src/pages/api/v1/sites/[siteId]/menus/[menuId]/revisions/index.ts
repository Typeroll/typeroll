// GET /api/v1/sites/{siteId}/menus/{menuId}/revisions
//
// Saved states of one menu on the key's version, newest first. Every save
// keeps the menu as it was before, so each entry can be restored. Entries
// carry metadata only; read one revision for the full menu.

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../../../lib/api-auth';
import { vstore } from '../../../../../../../../lib/version-store';
import { listRevisions } from '../../../../../../../../lib/revisions';
import { pathParam } from '../../../../../../../../lib/path-param';

export const GET: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const menuId = pathParam(params.menuId);
  if (!menuId) return apiError('Missing menuId', 400, ctx);
  if (!(await vstore.menu(ctx.orgId, ctx.siteId, ctx.versionId, menuId))) return apiError('Menu not found', 404, ctx);

  const url = new URL(request.url);
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 100);
  const revisions = await listRevisions({ orgId: ctx.orgId, siteId: ctx.siteId, versionId: ctx.versionId, kind: 'menu', resourceIds: [menuId] });
  return apiResponse(ctx, {
    revisions: revisions.slice(0, limit).map((rev) => ({
      id: rev.id,
      created_at: rev.created_at,
      created_by: rev.created_by,
      note: rev.note ?? null,
      name: typeof rev.doc?.name === 'string' ? rev.doc.name : null,
      item_count: Array.isArray(rev.doc?.items) ? rev.doc.items.length : 0,
      updated_at: rev.doc?.updated_at ?? null,
    })),
    total: revisions.length,
  });
};
