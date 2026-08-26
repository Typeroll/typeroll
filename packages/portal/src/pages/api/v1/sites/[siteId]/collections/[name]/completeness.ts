// GET /api/v1/sites/{siteId}/collections/{name}/completeness
//
// "Which records need work, worst first." Lets an enrichment agent ask for
// the fifty worst items instead of paging the whole collection and diffing
// client-side on every run.
//
// Computed at read time, never stored — a persisted score is wrong the moment
// anyone edits an item, and nothing would tell you it had gone stale.

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../../lib/api-auth';
import { vstore } from '../../../../../../../lib/version-store';
import { analyzeCompleteness } from '../../../../../../../lib/collection-completeness';

export const GET: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const { name } = params;
  if (!name) return apiError('Missing collection name');

  const coll = await vstore.collection(ctx.orgId, ctx.siteId, ctx.versionId, name);
  if (!coll) return apiError('Collection not found', 404);

  const q = new URL(request.url).searchParams;
  const limitRaw = Number(q.get('limit'));
  const staleRaw = Number(q.get('stale_after_days'));

  const items = await vstore.collectionItems(ctx.orgId, ctx.siteId, ctx.versionId, name);
  const report = analyzeCompleteness(coll, items, {
    limit: Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 500) : undefined,
    stale_after_days: Number.isFinite(staleRaw) && staleRaw > 0 ? staleRaw : undefined,
    // `?all_fields=true` reports gaps in fields no agent may write. Useful for
    // a human audit, useless as a worklist — an agent can't clear them.
    agent_writable_only: q.get('all_fields') !== 'true',
  });

  return apiResponse(ctx, report);
};
