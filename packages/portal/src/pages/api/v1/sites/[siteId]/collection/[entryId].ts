// GET    /api/v1/sites/{siteId}/collection/{entryId} — one entry with its package: { entry }
// PATCH  /api/v1/sites/{siteId}/collection/{entryId} — JSON { name?, description?, category? } → { entry }
// DELETE /api/v1/sites/{siteId}/collection/{entryId} — → { deleted: true, id, files_removed }
//
// Built-in entries are read-only. An app installation (collection:write)
// changes and removes only the entries it added (403 collection_entry_not_owned).

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiCollection, requireApiKey, type ApiContext } from '../../../../../../lib/api-auth';
import { collectionEntryDetail, collectionEntrySummary, deleteCollectionEntry, updateCollectionEntry } from '../../../../../../lib/collections/collections';
import { apiCollectionActor, collectionPreviewBase, collectionRefusal, entryForSite } from '../../../../../../lib/collections/collection-routes';

function failure(error: unknown, ctx: ApiContext): Response {
  const refused = collectionRefusal(error);
  return apiError(refused.body.error, refused.status, ctx, { code: refused.body.code, ...(refused.body.details ? { details: refused.body.details } : {}) });
}

export const GET: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const access = requireApiCollection(guard.value);
  if (!access.ok) return access.response;
  const ctx = guard.value;
  const entry = await entryForSite(ctx.orgId, ctx.siteId, ctx.versionId, params.entryId);
  if (!entry) return apiError('Collection entry not found', 404, ctx, { code: 'collection_entry_not_found' });
  return apiResponse(ctx, { entry: collectionEntryDetail(entry, collectionPreviewBase('/api/v1/sites', ctx.siteId)) });
};

export const PATCH: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const access = requireApiCollection(guard.value);
  if (!access.ok) return access.response;
  const ctx = guard.value;
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) return apiError('Send { name?, description?, category? }', 400, ctx, { code: 'collection_entry_invalid' });
  try {
    const entry = await updateCollectionEntry(ctx.orgId, params.entryId ?? '', body as Record<string, unknown>, apiCollectionActor(ctx));
    return apiResponse(ctx, { entry: collectionEntrySummary(entry, collectionPreviewBase('/api/v1/sites', ctx.siteId)) }, 200, body);
  } catch (error) { return failure(error, ctx); }
};

export const DELETE: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const access = requireApiCollection(guard.value);
  if (!access.ok) return access.response;
  const ctx = guard.value;
  try {
    return apiResponse(ctx, await deleteCollectionEntry(ctx.orgId, params.entryId ?? '', apiCollectionActor(ctx)));
  } catch (error) { return failure(error, ctx); }
};
