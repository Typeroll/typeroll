// CRUD for /api/sites/{siteId}/templates (PageTemplate docs).
//   GET    /api/sites/{siteId}/templates          → list
//   POST   /api/sites/{siteId}/templates          → create
//   PATCH  /api/sites/{siteId}/templates?id=…     → update
//   DELETE /api/sites/{siteId}/templates?id=…     → remove

import type { APIRoute } from 'astro';
import { json, requireSiteAccess, requirePermission } from '../../../../../lib/access';
import { getStore } from '../../../../../lib/datastore';
import { paths, type Block, type PageTemplate } from '@typeroll/shared';

const WRITABLE = new Set<keyof PageTemplate>([
  'name', 'label', 'icon', 'applies_to', 'blocks', 'status',
]);

function sanitizeWrite(input: Record<string, unknown>): Partial<PageTemplate> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(input)) {
    if (WRITABLE.has(k as keyof PageTemplate)) out[k] = input[k];
  }
  return out as Partial<PageTemplate>;
}

export const GET: APIRoute = async ({ cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const { session, site, versionId, owner_org_id } = guard.value;
  const docs = await getStore().listDocs<PageTemplate>(
    paths.pageTemplates(owner_org_id, site.id, versionId),
  );
  return json({ templates: docs });
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
  if (!clean.name || typeof clean.name !== 'string') {
    return json({ error: 'name is required' }, 400);
  }
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(clean.name)) {
    return json({ error: 'name must be lowercase kebab/underscore (1-64 chars)' }, 400);
  }
  const id = clean.name;
  const doc: PageTemplate = {
    id,
    name: clean.name,
    label: (clean.label as string) ?? clean.name,
    icon: clean.icon as string | undefined,
    applies_to: (clean.applies_to as PageTemplate['applies_to']) ?? 'any',
    blocks: (clean.blocks as Block[]) ?? [],
    status: (clean.status as PageTemplate['status']) ?? 'draft',
    created_at: new Date().toISOString(),
    date_updated: new Date().toISOString(),
  };
  await getStore().setDoc(`${paths.pageTemplates(owner_org_id, site.id, versionId)}/${id}`, doc);
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

  const docPath = `${paths.pageTemplates(owner_org_id, site.id, versionId)}/${id}`;
  const existing = await getStore().getDoc<PageTemplate>(docPath);
  if (!existing) return json({ error: 'Not found' }, 404);
  const merged: PageTemplate = {
    ...existing,
    ...clean,
    date_updated: new Date().toISOString(),
  };
  await getStore().setDoc(docPath, merged);
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
  await getStore().deleteDoc(`${paths.pageTemplates(owner_org_id, site.id, versionId)}/${id}`);
  return json({ ok: true });
};
