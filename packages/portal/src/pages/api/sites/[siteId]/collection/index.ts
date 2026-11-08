// GET /api/sites/{siteId}/collection — the organization collection seen from
//     this site: { entries: [{ id, kind, name, description?, category?,
//     preview_url?, languages?, source, read_only?, created_at, updated_at,
//     summary: { block_count?, top_level_types?, styles, block_types, media } }] }
//     The organization's own entries, newest first, then Typeroll's built-in
//     starters (read_only) for the site's render version. Packages are not
//     listed; read one entry with GET …/collection/{entryId}.
//
// The collection belongs to the site's organization: its owners,
// administrators and builders (every member while the organization does not
// enforce roles). A share never sees it, whatever its permission; that is
// answered 404 (lib/access → requireCollectionAccess).

import type { APIRoute } from 'astro';
import { json, requireCollectionAccess, requireSiteAccess } from '../../../../../lib/access';
import { listCollection } from '../../../../../lib/collections/collections';
import { collectionPreviewBase, siteRenderVersion } from '../../../../../lib/collections/collection-routes';

export const GET: APIRoute = async ({ cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const access = requireCollectionAccess(guard.value);
  if (!access.ok) return access.response;
  const { site, versionId, owner_org_id } = guard.value;
  const entries = await listCollection(owner_org_id, {
    renderVersion: await siteRenderVersion(owner_org_id, site.id, versionId),
    previewBase: collectionPreviewBase('/api/sites', site.id),
  });
  const response = json({ entries });
  response.headers.set('Cache-Control', 'no-store');
  return response;
};
