import type { APIRoute } from 'astro';
import { vstore } from '../../../../../lib/version-store';
import { requireSiteAccess, json, requirePermission } from '../../../../../lib/access';
import { getStore } from '../../../../../lib/datastore';
import { paths } from '@typeroll/shared';
import type { CollectionDef, CollectionItem } from '@typeroll/shared';

const ALLOWED = [
  'label_singular', 'label_plural', 'icon', 'fields',
  'slug_field', 'sort_field', 'sort_dir',
  // Free-form Schema.org type + field-name → schema-property mapping
  // used to auto-emit per-item JSON-LD on collection routes.
  'schema_type', 'schema_field_map',
] as const;

export const PUT: APIRoute = async ({ request, cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const writeCheck = requirePermission(guard.value, 'write');
  if (!writeCheck.ok) return writeCheck.response;
  const { session, site, versionId, owner_org_id } = guard.value;
  const { name } = params;
  if (!name) return json({ error: 'Missing name' }, 400);

  const body = (await request.json()) as Partial<CollectionDef>;
  const update: Record<string, unknown> = {};
  for (const k of ALLOWED) if (k in body) update[k] = (body as Record<string, unknown>)[k];

  const existing = await vstore.collection(owner_org_id, site.id, versionId, name);
  if (!existing) return json({ error: 'Not found' }, 404);

  await vstore.writeCollection(owner_org_id, site.id, versionId, name, update);
  return json({ ok: true });
};

export const DELETE: APIRoute = async ({ cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const writeCheck = requirePermission(guard.value, 'write');
  if (!writeCheck.ok) return writeCheck.response;
  const { session, site, versionId, owner_org_id } = guard.value;
  const { name } = params;
  if (!name) return json({ error: 'Missing name' }, 400);

  // Delete every item, then the collection itself. On a branch this writes
  // tombstones; on main it's a literal delete.
  const items = await vstore.collectionItems(owner_org_id, site.id, versionId, name);
  for (const it of items) {
    await vstore.deleteCollectionItem(owner_org_id, site.id, versionId, name, it.id);
  }
  await vstore.deleteCollection(owner_org_id, site.id, versionId, name);
  return json({ ok: true });
};
