import type { APIRoute } from 'astro';
import { vstore } from '../../../../../../../lib/version-store';
import { requireSiteAccess, json, requirePermission } from '../../../../../../../lib/access';
import { snapshotRevision } from '../../../../../../../lib/revisions';
import {
  PROVENANCE_KEY,
  applyFieldAuthority,
  conflictResponse,
} from '../../../../../../../lib/field-authority';

export const PUT: APIRoute = async ({ request, cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const writeCheck = requirePermission(guard.value, 'write');
  if (!writeCheck.ok) return writeCheck.response;
  const { session, site, versionId, owner_org_id } = guard.value;
  const { name, itemId } = params;
  if (!name || !itemId) return json({ error: 'Missing params' }, 400);

  const coll = await vstore.collection(owner_org_id, site.id, versionId, name);
  if (!coll) return json({ error: 'Collection not found' }, 404);

  const body = (await request.json()) as Record<string, unknown>;
  // Whitelist updates to fields defined in the schema + status.
  const allowed = new Set(['status', ...coll.fields.map((f) => f.name)]);
  const incoming: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (allowed.has(k)) incoming[k] = v;
  }

  const existing = await vstore.collectionItem(owner_org_id, site.id, versionId, name, itemId);
  if (!existing) return json({ error: 'Item not found' }, 404);

  // Second filter, on top of the schema whitelist: may THIS surface write
  // THESE fields, and does it outrank whoever wrote them last. `status` isn't
  // a schema field so it passes through untouched.
  const { status, ...fieldPatch } = incoming;
  const authority = applyFieldAuthority({
    fields: coll.fields,
    incoming: fieldPatch,
    existing,
    actor: 'portal',
    actorId: session.email ?? 'unknown',
  });
  if (authority.rejected.length > 0) {
    return json(conflictResponse(authority.rejected), 409);
  }
  const update: Record<string, unknown> = { ...authority.update };
  if (status !== undefined) update.status = status;
  if (Object.keys(authority.provenance).length > 0) {
    update[PROVENANCE_KEY] = authority.provenance;
  }
  update.updated_at = new Date().toISOString();

  await snapshotRevision({
    orgId: owner_org_id,
    siteId: site.id,
    versionId,
    kind: 'collection-item',
    resourceIds: [name, itemId],
    doc: existing as unknown as Record<string, unknown>,
    createdBy: session.email ?? 'unknown',
  });
  await vstore.writeCollectionItem(owner_org_id, site.id, versionId, name, itemId, update);
  return json({ ok: true });
};

export const DELETE: APIRoute = async ({ cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const writeCheck = requirePermission(guard.value, 'write');
  if (!writeCheck.ok) return writeCheck.response;
  const { session, site, versionId, owner_org_id } = guard.value;
  const { name, itemId } = params;
  if (!name || !itemId) return json({ error: 'Missing params' }, 400);

  await vstore.deleteCollectionItem(owner_org_id, site.id, versionId, name, itemId);
  return json({ ok: true });
};

export const GET: APIRoute = async ({ cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const { session, site, versionId, owner_org_id } = guard.value;
  const { name, itemId } = params;
  if (!name || !itemId) return json({ error: 'Missing params' }, 400);

  const item = await vstore.collectionItem(owner_org_id, site.id, versionId, name, itemId);
  if (!item) return json({ error: 'Not found' }, 404);
  return json(item);
};
