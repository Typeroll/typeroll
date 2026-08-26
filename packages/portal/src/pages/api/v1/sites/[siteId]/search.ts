// GET /api/v1/sites/{siteId}/search?contains=...
//                                  ?regex=... (case-insensitive)
//                                  ?limit=...  (default 500, max 500)
//
// Wraps lib/bulk-operations.findPagesMatching. Returns page_id + title +
// slug + status + excerpt for the first hit on each matching page.
// Either contains or regex is required.

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../lib/api-auth';
import { findPagesMatching } from '../../../../../lib/bulk-operations';

export const GET: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const url = new URL(request.url);
  const contains = url.searchParams.get('contains') ?? undefined;
  const regex = url.searchParams.get('regex') ?? undefined;
  const limitParam = url.searchParams.get('limit');
  const limit = limitParam ? Math.max(1, Math.min(500, Number(limitParam) || 500)) : undefined;
  if (!contains && !regex) return apiError('Provide either ?contains= or ?regex=');

  try {
    const r = await findPagesMatching(ctx.orgId, ctx.siteId, ctx.versionId, { contains, regex, limit });
    return apiResponse(ctx, r);
  } catch (e) {
    return apiError(e instanceof Error ? e.message : 'Search failed', 400);
  }
};
