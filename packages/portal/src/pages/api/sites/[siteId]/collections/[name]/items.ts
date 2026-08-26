import type { APIRoute } from 'astro';
import { vstore } from '../../../../../../lib/version-store';
import { requireSiteAccess, json, requirePermission } from '../../../../../../lib/access';
import { getStore, generateDocId } from '../../../../../../lib/datastore';
import { paths } from '@typeroll/shared';
import type { CollectionDef } from '@typeroll/shared';

// Create a new item. Accepts JSON or an empty form POST (in which case we
// create a placeholder draft and redirect to the editor — that's how the
// "+ New" button on the collection page works).
export const POST: APIRoute = async ({ request, cookies, params, redirect, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const writeCheck = requirePermission(guard.value, 'write');
  if (!writeCheck.ok) return writeCheck.response;
  const { session, site, versionId, owner_org_id } = guard.value;
  const { name } = params;
  if (!name) return json({ error: 'Missing collection name' }, 400);

  const store = getStore();
  const coll = await vstore.collection(owner_org_id, site.id, versionId, name);
  if (!coll) return json({ error: 'Collection not found' }, 404);

  const isJson = (request.headers.get('content-type') ?? '').includes('application/json');
  const body = isJson ? ((await request.json()) as Record<string, unknown>) : {};

  const now = new Date().toISOString();
  const itemId = generateDocId();
  const doc: Record<string, unknown> = {
    status: 'draft',
    ...body,
    created_at: now,
    updated_at: now,
  };
  // Defaults from schema
  for (const f of coll.fields) {
    if (doc[f.name] === undefined && f.default !== undefined) doc[f.name] = f.default;
  }
  await store.setDoc(paths.collectionItem(owner_org_id, site.id, name, itemId, versionId), doc);

  if (isJson) {
    return json({ ok: true, id: itemId });
  }
  return redirect(`/app/sites/${site.id}/collections/${name}/items/${itemId}`);
};

export const GET: APIRoute = async ({ cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const { session, site, versionId, owner_org_id } = guard.value;
  const { name } = params;
  if (!name) return json({ error: 'Missing collection name' }, 400);

  const items = await getStore().listDocs(paths.collectionItems(owner_org_id, site.id, name, versionId));
  return json(items);
};
