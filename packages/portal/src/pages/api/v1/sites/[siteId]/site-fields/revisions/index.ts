// GET /api/v1/sites/{siteId}/site-fields/revisions
//
// Saved states of the site fields on the key's version, newest first. Every
// save keeps the document as it was before, so each entry can be restored.
// Entries carry metadata only.

import type { APIRoute } from 'astro';
import { apiResponse, requireApiKey } from '../../../../../../../lib/api-auth';
import { listRevisions } from '../../../../../../../lib/revisions';

export const GET: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const url = new URL(request.url);
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 100);
  const revisions = await listRevisions({ orgId: ctx.orgId, siteId: ctx.siteId, versionId: ctx.versionId, kind: 'site_fields', resourceIds: ['default'] });
  return apiResponse(ctx, {
    revisions: revisions.slice(0, limit).map((rev) => ({
      id: rev.id,
      created_at: rev.created_at,
      created_by: rev.created_by,
      note: rev.note ?? null,
      group_count: Array.isArray(rev.doc?.groups) ? rev.doc.groups.length : 0,
      value_count: rev.doc?.values && typeof rev.doc.values === 'object' ? Object.keys(rev.doc.values).length : 0,
      updated_at: rev.doc?.updated_at ?? null,
    })),
    total: revisions.length,
  });
};
