// POST /api/sites/{siteId}/collection/save — save one of this site's block
//      templates, page templates, free global blocks or block types to the
//      organization collection.
//      JSON: { kind: "section" | "block_template" | "page_template" | "global_block" | "block_type",
//              id, name?, description?, category? } → 201 { entry, warnings }
//
// A block template becomes a section or block_template entry by its own
// kind. The entry carries the styles, block types, global blocks and media
// the content uses. Owners, administrators and builders of the owning
// organization (lib/access → requireCollectionAccess).

import type { APIRoute } from 'astro';
import { json, requireCollectionAccess, requirePermission, requireSiteAccess } from '../../../../../lib/access';
import { collectionEntrySummary, saveToCollection } from '../../../../../lib/collections/collections';
import { collectionPreviewBase, collectionRefusal } from '../../../../../lib/collections/collection-routes';

export const POST: APIRoute = async ({ request, cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const access = requireCollectionAccess(guard.value);
  if (!access.ok) return access.response;
  const write = requirePermission(guard.value, 'write');
  if (!write.ok) return write.response;
  const { session, site, versionId, owner_org_id } = guard.value;
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') return json({ error: 'Send { kind, id, name?, description?, category? }', code: 'collection_entry_invalid' }, 400);
  try {
    const { entry, warnings } = await saveToCollection({ orgId: owner_org_id, siteId: site.id, versionId }, body, { label: session.email || session.userId });
    return json({ entry: collectionEntrySummary(entry, collectionPreviewBase('/api/sites', site.id)), warnings }, 201);
  } catch (error) {
    const refused = collectionRefusal(error);
    return json(refused.body, refused.status);
  }
};
