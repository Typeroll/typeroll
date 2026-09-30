// GET /api/v1/sites/{siteId}/pages/{pageId}/revisions/{revId}
//
// One revision with the full page document as it was saved.

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../../../lib/api-auth';
import { getRevision } from '../../../../../../../../lib/revisions';

export const GET: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const { pageId, revId } = params;
  if (!pageId || !revId) return apiError('Missing pageId or revId');
  const rev = await getRevision({ orgId: ctx.orgId, siteId: ctx.siteId, versionId: ctx.versionId, kind: 'page', resourceIds: [pageId], revId });
  if (!rev) return apiError('Revision not found', 404);
  return apiResponse(ctx, { revision: { ...rev, id: revId } });
};
