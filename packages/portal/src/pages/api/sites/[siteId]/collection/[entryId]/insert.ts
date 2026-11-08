// POST /api/sites/{siteId}/collection/{entryId}/insert — insert an entry into this site.
//      JSON: { target: "library" }
//            → the block template, page template, global block or block type
//              (or a whole package's content) is added to the site;
//            { target: "page", page_id, after_block_id? | position?, parent_id?, slot_index? }
//            → a section's, block template's or global block's blocks are
//              placed in the page's draft, after the given block (in its
//              parent or slot, when it is nested) or at the position (end
//              by default); the styles, block types, global blocks and media
//              they use are added to the site.
//      → { report, page?: { id, added_ids, blocks } }
//
// An insert is a package import: every style the entry uses is created on
// the site, never mapped to a "nearest" one; a differing style with the same
// id is created under a new id and the content rewritten to it. A built-in
// header or footer replaces the site's own. Needs collection access and
// write permission on the site.

import type { APIRoute } from 'astro';
import { json, requireCollectionAccess, requirePermission, requireSiteAccess } from '../../../../../../lib/access';
import { insertFromCollection, parseInsertTarget } from '../../../../../../lib/collections/collections';
import { collectionRefusal, entryForSite } from '../../../../../../lib/collections/collection-routes';

export const POST: APIRoute = async ({ request, cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const access = requireCollectionAccess(guard.value);
  if (!access.ok) return access.response;
  const write = requirePermission(guard.value, 'write');
  if (!write.ok) return write.response;
  const { session, site, versionId, owner_org_id, permission, design } = guard.value;
  const body = await request.json().catch(() => ({}));
  try {
    const target = parseInsertTarget(body);
    const entry = await entryForSite(owner_org_id, site.id, versionId, params.entryId);
    if (!entry) return json({ error: 'Collection entry not found', code: 'collection_entry_not_found' }, 404);
    const result = await insertFromCollection({ orgId: owner_org_id, siteId: site.id, versionId, permission, design, actor: session.email || session.userId }, entry, target);
    return json(result);
  } catch (error) {
    const refused = collectionRefusal(error);
    return json(refused.body, refused.status);
  }
};
