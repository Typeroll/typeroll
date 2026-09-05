// Cookie-authenticated CRUD for the per-site BlockType collection.
//   GET    /api/sites/{siteId}/blocks/types          → list
//   POST   /api/sites/{siteId}/blocks/types          → create
//   PATCH  /api/sites/{siteId}/blocks/types?id=…     → update
//   DELETE /api/sites/{siteId}/blocks/types?id=…     → remove
//
// Whitelisted writes. The chat-AI tool surface has a parallel route that
// strips the `script` field — this route keeps it (the user, by submitting
// the form with JS enabled, is taking responsibility).

import type { APIRoute } from 'astro';
import { json, requireSiteAccess, requirePermission } from '../../../../../lib/access';
import { getStore } from '../../../../../lib/datastore';
import { vstore } from '../../../../../lib/version-store';
import { paths, type BlockType, type FieldDefinition } from '@typeroll/shared';

const WRITABLE = new Set<keyof BlockType>([
  'name', 'label', 'icon', 'category', 'container', 'slot_count', 'slot_labels',
  'schema', 'template', 'styles', 'script',
]);

function sanitizeWrite(input: Record<string, unknown>): Partial<BlockType> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(input)) {
    if (WRITABLE.has(k as keyof BlockType)) out[k] = input[k];
  }
  return out as Partial<BlockType>;
}

function validate(doc: Partial<BlockType>): string | null {
  if (doc.name !== undefined && !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(doc.name)) {
    return 'name must be lowercase kebab/underscore (1-64 chars)';
  }
  if (doc.category !== undefined && !['layout', 'content', 'media', 'custom'].includes(doc.category)) {
    return 'category must be layout | content | media | custom';
  }
  if (doc.container !== undefined && doc.container !== true && doc.container !== false && doc.container !== 'slots') {
    return 'container must be true | false | "slots"';
  }
  if (doc.container === 'slots') {
    if (typeof doc.slot_count !== 'number' || doc.slot_count < 1 || doc.slot_count > 8) {
      return 'slot_count must be 1-8 when container="slots"';
    }
  }
  if (doc.schema !== undefined && !Array.isArray(doc.schema)) {
    return 'schema must be an array';
  }
  return null;
}

export const GET: APIRoute = async ({ cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const { session, site, versionId, owner_org_id } = guard.value;
  const docs = await vstore.blockTypes(owner_org_id, site.id, versionId);
  return json({ block_types: docs });
};

export const POST: APIRoute = async ({ request, cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const writeCheck = requirePermission(guard.value, 'write');
  if (!writeCheck.ok) return writeCheck.response;
  const { session, site, versionId, owner_org_id } = guard.value;
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return json({ error: 'Invalid JSON' }, 400);
  const clean = sanitizeWrite(body);
  const err = validate(clean);
  if (err) return json({ error: err }, 400);
  if (!clean.name) return json({ error: 'name is required' }, 400);

  // Flat id (no slash) — the datastore lists docs directly in the dir,
  // a slash would put us in a subcollection that listDocs can't see.
  // `origin: 'user'` is what distinguishes user blocks from core (which
  // live in code and never hit the datastore).
  const id = clean.name as string;
  const existing = await vstore.blockType(owner_org_id, site.id, versionId, id);
  if (existing) return json({ error: `Block type "${id}" already exists` }, 409);
  const doc: BlockType = {
    id,
    name: clean.name as string,
    label: (clean.label as string) ?? clean.name as string,
    icon: clean.icon as string | undefined,
    category: (clean.category as BlockType['category']) ?? 'custom',
    container: (clean.container as BlockType['container']) ?? false,
    slot_count: clean.slot_count as number | undefined,
    slot_labels: clean.slot_labels as string[] | undefined,
    schema: (clean.schema as FieldDefinition[]) ?? [],
    template: clean.template as string | undefined,
    styles: clean.styles as string | undefined,
    script: clean.script as string | undefined,
    origin: 'user',
    created_at: new Date().toISOString(),
  };
  await getStore().setDoc(`${paths.blockTypes(owner_org_id, site.id, versionId)}/${id}`, doc);
  return json(doc);
};

export const PATCH: APIRoute = async ({ request, cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const writeCheck = requirePermission(guard.value, 'write');
  if (!writeCheck.ok) return writeCheck.response;
  const { session, site, versionId, owner_org_id } = guard.value;
  const url = new URL(request.url);
  const id = url.searchParams.get('id');
  if (!id) return json({ error: 'id query param required' }, 400);
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return json({ error: 'Invalid JSON' }, 400);
  const clean = sanitizeWrite(body);
  const err = validate(clean);
  if (err) return json({ error: err }, 400);

  const existing = await vstore.blockType(owner_org_id, site.id, versionId, id);
  if (!existing) return json({ error: 'Not found' }, 404);
  const merged: BlockType = { ...existing, ...clean };
  await vstore.writeBlockType(owner_org_id, site.id, versionId, id, merged);
  return json(merged);
};

export const DELETE: APIRoute = async ({ request, cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const writeCheck = requirePermission(guard.value, 'write');
  if (!writeCheck.ok) return writeCheck.response;
  const { session, site, versionId, owner_org_id } = guard.value;
  const url = new URL(request.url);
  const id = url.searchParams.get('id');
  if (!id) return json({ error: 'id query param required' }, 400);
  const existing = await vstore.blockType(owner_org_id, site.id, versionId, id);
  if (!existing) return json({ error: 'Not found' }, 404);
  await vstore.deleteBlockType(owner_org_id, site.id, versionId, id);
  return json({ ok: true });
};
