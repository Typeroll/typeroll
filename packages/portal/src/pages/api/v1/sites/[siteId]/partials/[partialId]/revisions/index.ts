// GET /api/v1/sites/{siteId}/partials/{partialId}/revisions
//
// Saved-state history of one partial (header, footer or global block) on the
// key's version, newest first. Every save snapshots the partial as it was
// before the save, so each entry is a state it can be restored to. Entries
// carry metadata only; read one revision for its full document. Same history
// the portal's partial editor shows.

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../../../lib/api-auth';
import { vstore } from '../../../../../../../../lib/version-store';
import { listRevisions } from '../../../../../../../../lib/revisions';
import { pathParam } from '../../../../../../../../lib/path-param';

export const GET: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const partialId = pathParam(params.partialId);
  if (!partialId) return apiError('Missing partialId', 400, ctx);
  if (!(await vstore.partial(ctx.orgId, ctx.siteId, ctx.versionId, partialId))) return apiError('Partial not found', 404, ctx);

  const url = new URL(request.url);
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 100);
  const revisions = await listRevisions({ orgId: ctx.orgId, siteId: ctx.siteId, versionId: ctx.versionId, kind: 'partial', resourceIds: [partialId] });
  return apiResponse(ctx, {
    revisions: revisions.slice(0, limit).map((rev) => ({
      id: rev.id,
      created_at: rev.created_at,
      created_by: rev.created_by,
      note: rev.note ?? null,
      name: typeof rev.doc?.name === 'string' ? rev.doc.name : null,
      content_mode: rev.doc?.content_mode ?? null,
      date_updated: rev.doc?.date_updated ?? null,
    })),
    total: revisions.length,
  });
};
