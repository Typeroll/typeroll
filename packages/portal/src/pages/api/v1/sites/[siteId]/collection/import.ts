// POST /api/v1/sites/{siteId}/collection/import — add a .typeroll file to the
//      organization collection.
//      JSON: { data_base64 | source_url } → 201 { entries, warnings }
//
// A collection package becomes one entry per block template, page template,
// free global block and block type; a site package is kept whole as one
// entry of kind "package". An app installation with collection:write adds
// ready-made entries this way: they record source.type "app" and its
// extension id, and the app may later change or remove only those.

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiCollection, requireApiKey } from '../../../../../../lib/api-auth';
import { addPackageToCollection, collectionEntrySummary } from '../../../../../../lib/collections/collections';
import { apiCollectionActor, collectionPreviewBase, collectionRefusal } from '../../../../../../lib/collections/collection-routes';
import { packageFromJson } from '../../../../../../lib/packages/package-requests';

export const POST: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const access = requireApiCollection(guard.value);
  if (!access.ok) return access.response;
  const ctx = guard.value;
  try {
    const { bytes } = await packageFromJson(request);
    const { entries, warnings } = await addPackageToCollection(ctx.orgId, bytes, apiCollectionActor(ctx));
    const base = collectionPreviewBase('/api/v1/sites', ctx.siteId);
    return apiResponse(ctx, { entries: entries.map(entry => collectionEntrySummary(entry, base)), warnings }, 201, { entries: entries.length });
  } catch (error) {
    const refused = collectionRefusal(error);
    return apiError(refused.body.error, refused.status, ctx, { code: refused.body.code, ...(refused.body.details ? { details: refused.body.details } : {}) });
  }
};
