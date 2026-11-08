// POST /api/sites/{siteId}/collection/import — add a .typeroll file to the
//      organization collection. multipart/form-data: file → 201 { entries, warnings }
//
// A collection package becomes one entry per block template, page template,
// free global block and block type, each with what it depends on; a site
// package is kept whole as one entry of kind "package". Nothing is added to
// the site. Owners, administrators and builders of the owning organization.

import type { APIRoute } from 'astro';
import { json, requireCollectionAccess, requirePermission, requireSiteAccess } from '../../../../../lib/access';
import { addPackageToCollection, collectionEntrySummary } from '../../../../../lib/collections/collections';
import { collectionPreviewBase, collectionRefusal } from '../../../../../lib/collections/collection-routes';
import { packageUpload } from '../../../../../lib/packages/package-requests';

export const POST: APIRoute = async ({ request, cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const access = requireCollectionAccess(guard.value);
  if (!access.ok) return access.response;
  const write = requirePermission(guard.value, 'write');
  if (!write.ok) return write.response;
  const { session, site, owner_org_id } = guard.value;
  try {
    const upload = await packageUpload(request);
    const { entries, warnings } = await addPackageToCollection(owner_org_id, upload.bytes, { label: session.email || session.userId });
    const base = collectionPreviewBase('/api/sites', site.id);
    return json({ entries: entries.map(entry => collectionEntrySummary(entry, base)), warnings }, 201);
  } catch (error) {
    const refused = collectionRefusal(error);
    return json(refused.body, refused.status);
  }
};
