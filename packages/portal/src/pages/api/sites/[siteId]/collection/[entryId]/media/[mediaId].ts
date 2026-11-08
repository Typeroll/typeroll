// GET /api/sites/{siteId}/collection/{entryId}/media/{mediaId} — a file of an
//     entry's package (its preview image), for signed-in members who may use
//     the collection. Private; never a public address.

import type { APIRoute } from 'astro';
import { json, requireCollectionAccess, requireSiteAccess } from '../../../../../../../lib/access';
import { collectionEntryMedia } from '../../../../../../../lib/collections/collections';
import { collectionRefusal, entryForSite, mediaResponse } from '../../../../../../../lib/collections/collection-routes';

export const GET: APIRoute = async ({ cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const access = requireCollectionAccess(guard.value);
  if (!access.ok) return access.response;
  const { site, versionId, owner_org_id } = guard.value;
  const entry = await entryForSite(owner_org_id, site.id, versionId, params.entryId);
  if (!entry) return json({ error: 'Not found', code: 'not_found' }, 404);
  try {
    const file = await collectionEntryMedia(owner_org_id, entry, params.mediaId ?? '');
    return file ? mediaResponse(file) : json({ error: 'Not found', code: 'not_found' }, 404);
  } catch (error) {
    const refused = collectionRefusal(error);
    return json(refused.body, refused.status);
  }
};
