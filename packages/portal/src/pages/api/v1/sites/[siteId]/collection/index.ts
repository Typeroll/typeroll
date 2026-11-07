// GET /api/v1/sites/{siteId}/collection — the organization collection seen
//     from this site: { entries: [...] }, the same summaries as the portal
//     (GET /api/sites/{siteId}/collection): the organization's entries, then
//     Typeroll's built-ins (read_only). Packages are not listed; read one
//     entry with GET …/collection/{entryId}.
//
// An organization API key of the owning organization, a personal connection
// of an owner, administrator or builder there, or an app installation with
// collection:read. A share or a site-scoped key is answered 404
// (lib/api-auth → requireApiCollection).

import type { APIRoute } from 'astro';
import { apiResponse, requireApiCollection, requireApiKey } from '../../../../../../lib/api-auth';
import { listCollection } from '../../../../../../lib/collections/collections';
import { collectionPreviewBase, siteRenderVersion } from '../../../../../../lib/collections/collection-routes';

export const GET: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const access = requireApiCollection(guard.value);
  if (!access.ok) return access.response;
  const ctx = guard.value;
  const entries = await listCollection(ctx.orgId, {
    renderVersion: await siteRenderVersion(ctx.orgId, ctx.siteId, ctx.versionId),
    previewBase: collectionPreviewBase('/api/v1/sites', ctx.siteId),
  });
  return apiResponse(ctx, { entries });
};
