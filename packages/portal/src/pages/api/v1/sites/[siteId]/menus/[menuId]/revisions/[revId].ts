// GET /api/v1/sites/{siteId}/menus/{menuId}/revisions/{revId}
//
// One menu revision with the full menu as it was saved.

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../../../lib/api-auth';
import { getRevision } from '../../../../../../../../lib/revisions';
import { pathParam } from '../../../../../../../../lib/path-param';

export const GET: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const menuId = pathParam(params.menuId);
  const revId = pathParam(params.revId);
  if (!menuId || !revId) return apiError('Missing menuId or revId', 400, ctx);
  const rev = await getRevision({ orgId: ctx.orgId, siteId: ctx.siteId, versionId: ctx.versionId, kind: 'menu', resourceIds: [menuId], revId });
  if (!rev) return apiError('Revision not found', 404, ctx);
  return apiResponse(ctx, { revision: { ...rev, id: revId } });
};
