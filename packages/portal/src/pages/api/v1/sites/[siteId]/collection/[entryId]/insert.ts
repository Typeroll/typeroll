// POST /api/v1/sites/{siteId}/collection/{entryId}/insert — insert an entry into the site.
//      JSON: { target: "library" }
//          | { target: "page", page_id, after_block_id? | position?, parent_id?, slot_index? }
//      → { report, page?: { id, added_ids, blocks } }
// Same as the portal route: styles are created on the site, never mapped.
// Needs write permission on the site; not for app installations.

import type { APIRoute } from 'astro';
import { apiCanDesign, apiError, apiResponse, requireApiCollection, requireApiKey } from '../../../../../../../lib/api-auth';
import { insertFromCollection, parseInsertTarget } from '../../../../../../../lib/collections/collections';
import { apiCollectionActor, collectionRefusal, entryForSite } from '../../../../../../../lib/collections/collection-routes';

export const POST: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const access = requireApiCollection(guard.value);
  if (!access.ok) return access.response;
  const ctx = guard.value;
  if (ctx.extensionIdentity) return apiError('App installations cannot insert collection entries', 403, ctx);
  if (ctx.permission === 'read') return apiError('Insufficient permission (write required)', 403, ctx);
  const body = await request.json().catch(() => ({}));
  try {
    const target = parseInsertTarget(body);
    const entry = await entryForSite(ctx.orgId, ctx.siteId, ctx.versionId, params.entryId);
    if (!entry) return apiError('Collection entry not found', 404, ctx, { code: 'collection_entry_not_found' });
    const result = await insertFromCollection({ orgId: ctx.orgId, siteId: ctx.siteId, versionId: ctx.versionId, permission: ctx.permission, design: apiCanDesign(ctx), actor: apiCollectionActor(ctx).label }, entry, target);
    return apiResponse(ctx, result, 200, body);
  } catch (error) {
    const refused = collectionRefusal(error);
    return apiError(refused.body.error, refused.status, ctx, { code: refused.body.code, ...(refused.body.details ? { details: refused.body.details } : {}) });
  }
};
