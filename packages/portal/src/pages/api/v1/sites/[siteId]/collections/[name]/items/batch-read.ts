// POST /api/v1/sites/{siteId}/collections/{name}/items/batch-read
//
// Body: { item_ids: string[] }   — up to BATCH_MAX
// Returns: { items: Array<{ item_id, found, item? }> }

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../../../lib/api-auth';
import { vstore } from '../../../../../../../../lib/version-store';

const BATCH_MAX = 200;

export const POST: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const name = params.name;
  if (!name) return apiError('Missing name');
  const body = (await request.json().catch(() => null)) as { item_ids?: unknown } | null;
  if (!body || !Array.isArray(body.item_ids)) return apiError('Body must be { item_ids: string[] }');
  const ids = (body.item_ids as unknown[]).filter((x): x is string => typeof x === 'string');
  if (ids.length === 0) return apiResponse(ctx, { items: [] });
  if (ids.length > BATCH_MAX) return apiError(`Too many ids (max ${BATCH_MAX})`);

  const results = await Promise.all(
    ids.map(async (id) => {
      const item = await vstore.collectionItem(ctx.orgId, ctx.siteId, ctx.versionId, name, id);
      return item ? { item_id: id, found: true, item } : { item_id: id, found: false };
    }),
  );
  return apiResponse(ctx, { items: results });
};
