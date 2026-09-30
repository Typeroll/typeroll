// GET /api/v1/sites/{siteId}/pages/{pageId}/revisions
//
// Saved-state history of one page on the key's version, newest first. Every
// save snapshots the page as it was before the save, so each entry is a state
// the page can be restored to. Entries carry metadata only; read one revision
// for its full document.

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../../../lib/api-auth';
import { vstore } from '../../../../../../../../lib/version-store';
import { listRevisions } from '../../../../../../../../lib/revisions';

export const GET: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const pageId = params.pageId;
  if (!pageId) return apiError('Missing pageId');
  if (!(await vstore.page(ctx.orgId, ctx.siteId, ctx.versionId, pageId))) return apiError('Page not found', 404);

  const url = new URL(request.url);
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 100);
  const revisions = await listRevisions({ orgId: ctx.orgId, siteId: ctx.siteId, versionId: ctx.versionId, kind: 'page', resourceIds: [pageId] });
  return apiResponse(ctx, {
    revisions: revisions.slice(0, limit).map((rev) => ({
      id: rev.id,
      created_at: rev.created_at,
      created_by: rev.created_by,
      note: rev.note ?? null,
      title: typeof rev.doc?.title === 'string' ? rev.doc.title : null,
      content_mode: rev.doc?.content_mode ?? null,
      date_updated: rev.doc?.date_updated ?? null,
    })),
    total: revisions.length,
  });
};
