// POST /api/v1/sites/{siteId}/collection/save — save one of the site's block
//      templates, page templates, free global blocks or block types to the
//      organization collection.
//      JSON: { kind: "section" | "block_template" | "page_template" | "global_block" | "block_type",
//              id, name?, description?, category? } → 201 { entry, warnings }
// Same as the portal route; not for app installations.

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiCollection, requireApiKey } from '../../../../../../lib/api-auth';
import { collectionEntrySummary, saveToCollection } from '../../../../../../lib/collections/collections';
import { apiCollectionActor, collectionPreviewBase, collectionRefusal } from '../../../../../../lib/collections/collection-routes';

export const POST: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const access = requireApiCollection(guard.value);
  if (!access.ok) return access.response;
  const ctx = guard.value;
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') return apiError('Send { kind, id, name?, description?, category? }', 400, ctx, { code: 'collection_entry_invalid' });
  try {
    const { entry, warnings } = await saveToCollection({ orgId: ctx.orgId, siteId: ctx.siteId, versionId: ctx.versionId }, body, apiCollectionActor(ctx));
    return apiResponse(ctx, { entry: collectionEntrySummary(entry, collectionPreviewBase('/api/v1/sites', ctx.siteId)), warnings }, 201, body);
  } catch (error) {
    const refused = collectionRefusal(error);
    return apiError(refused.body.error, refused.status, ctx, { code: refused.body.code, ...(refused.body.details ? { details: refused.body.details } : {}) });
  }
};
