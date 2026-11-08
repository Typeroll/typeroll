// GET    /api/sites/{siteId}/collection/{entryId} — one entry with its package: { entry }
// PATCH  /api/sites/{siteId}/collection/{entryId} — JSON { name?, description?, category? } → { entry }
// DELETE /api/sites/{siteId}/collection/{entryId} — → { deleted: true, id, files_removed }
//
// Built-in entries are read-only (403 collection_entry_read_only). Deleting
// also removes the stored files no other entry uses. Owners, administrators
// and builders of the owning organization.

import type { APIRoute } from 'astro';
import { json, requireCollectionAccess, requirePermission, requireSiteAccess } from '../../../../../lib/access';
import { collectionEntryDetail, collectionEntrySummary, deleteCollectionEntry, updateCollectionEntry } from '../../../../../lib/collections/collections';
import { collectionPreviewBase, collectionRefusal, entryForSite } from '../../../../../lib/collections/collection-routes';

export const GET: APIRoute = async ({ cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const access = requireCollectionAccess(guard.value);
  if (!access.ok) return access.response;
  const { site, versionId, owner_org_id } = guard.value;
  const entry = await entryForSite(owner_org_id, site.id, versionId, params.entryId);
  if (!entry) return json({ error: 'Collection entry not found', code: 'collection_entry_not_found' }, 404);
  return json({ entry: collectionEntryDetail(entry, collectionPreviewBase('/api/sites', site.id)) });
};

export const PATCH: APIRoute = async ({ request, cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const access = requireCollectionAccess(guard.value);
  if (!access.ok) return access.response;
  const write = requirePermission(guard.value, 'write');
  if (!write.ok) return write.response;
  const { session, site, owner_org_id } = guard.value;
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'Send { name?, description?, category? }', code: 'collection_entry_invalid' }, 400);
  try {
    const entry = await updateCollectionEntry(owner_org_id, params.entryId ?? '', body as Record<string, unknown>, { label: session.email || session.userId });
    return json({ entry: collectionEntrySummary(entry, collectionPreviewBase('/api/sites', site.id)) });
  } catch (error) {
    const refused = collectionRefusal(error);
    return json(refused.body, refused.status);
  }
};

export const DELETE: APIRoute = async ({ cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const access = requireCollectionAccess(guard.value);
  if (!access.ok) return access.response;
  const write = requirePermission(guard.value, 'write');
  if (!write.ok) return write.response;
  const { session, owner_org_id } = guard.value;
  try {
    return json(await deleteCollectionEntry(owner_org_id, params.entryId ?? '', { label: session.email || session.userId }));
  } catch (error) {
    const refused = collectionRefusal(error);
    return json(refused.body, refused.status);
  }
};
