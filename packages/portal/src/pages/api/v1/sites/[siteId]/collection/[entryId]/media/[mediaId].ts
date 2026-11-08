// GET /api/v1/sites/{siteId}/collection/{entryId}/media/{mediaId} — a file of
//     an entry's package (its preview image). Same access as listing.

import type { APIRoute } from 'astro';
import { apiError, requireApiCollection, requireApiKey, withApiIdentity } from '../../../../../../../../lib/api-auth';
import { collectionEntryMedia } from '../../../../../../../../lib/collections/collections';
import { collectionRefusal, entryForSite, mediaResponse } from '../../../../../../../../lib/collections/collection-routes';

export const GET: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const access = requireApiCollection(guard.value);
  if (!access.ok) return access.response;
  const ctx = guard.value;
  const entry = await entryForSite(ctx.orgId, ctx.siteId, ctx.versionId, params.entryId);
  if (!entry) return apiError('Not found', 404, ctx, { code: 'not_found' });
  try {
    const file = await collectionEntryMedia(ctx.orgId, entry, params.mediaId ?? '');
    return file ? withApiIdentity(ctx, mediaResponse(file)) : apiError('Not found', 404, ctx, { code: 'not_found' });
  } catch (error) {
    const refused = collectionRefusal(error);
    return apiError(refused.body.error, refused.status, ctx, { code: refused.body.code });
  }
};
