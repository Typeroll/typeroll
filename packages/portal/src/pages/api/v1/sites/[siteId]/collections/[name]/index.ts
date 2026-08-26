// GET    /api/v1/sites/{siteId}/collections/{name}     read schema
// PATCH  /api/v1/sites/{siteId}/collections/{name}     update schema
// DELETE /api/v1/sites/{siteId}/collections/{name}     delete (with confirm)

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../../lib/api-auth';
import { vstore } from '../../../../../../../lib/version-store';
import { getStore } from '../../../../../../../lib/datastore';
import { sanitizeBody } from '../../../../../../../lib/sanitize';
import { effectiveRouteTemplate, ensureBlockIds, paths } from '@typeroll/shared';
import type { CollectionDef } from '@typeroll/shared';

/**
 * Project a collection doc for the API response. Adds the derived
 * `effective_route_template` field so agents can see what the renderer
 * will actually use (raw value when set, the platform default
 * `/{name}/{slug_field}` otherwise). Matches the shape returned by
 * list_collections.
 */
function project(c: CollectionDef): Record<string, unknown> {
  return {
    ...c,
    effective_route_template: effectiveRouteTemplate(c),
  };
}

const WRITABLE_FIELDS: Array<keyof CollectionDef> = [
  'label_singular', 'label_plural', 'icon', 'fields',
  'slug_field', 'sort_field', 'sort_dir',
  'route_template', 'item_template_html',
  // Block-tree alternative to item_template_html. Renderer prefers
  // blocks when both are set. Stored as Block[] — sanitisation happens
  // when each block's template HTML lands via the BlockType save flow
  // (per-type templates are pre-sanitised), not here.
  'item_template_blocks',
  // Free-form Schema.org type for auto JSON-LD on item routes +
  // optional field-name → schema-property mapping. See types.ts.
  'schema_type', 'schema_field_map',
];

function pickWritable(body: Partial<CollectionDef>): Partial<CollectionDef> {
  const out: Partial<CollectionDef> = {};
  for (const k of WRITABLE_FIELDS) {
    if (body[k] !== undefined) (out as Record<string, unknown>)[k] = body[k];
  }
  // Sanitize the item template at save time so the renderer's pre-merge
  // substitution doesn't have to worry about embedded <script>.
  if (typeof out.item_template_html === 'string') {
    out.item_template_html = sanitizeBody(out.item_template_html);
  }
  // Hand-authored block trees may lack ids — normalise (renderer +
  // per-block tools require them).
  if (Array.isArray(out.item_template_blocks)) {
    out.item_template_blocks = ensureBlockIds(out.item_template_blocks);
  }
  return out;
}

export const GET: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const name = params.name;
  if (!name) return apiError('Missing name');
  const coll = await vstore.collection(ctx.orgId, ctx.siteId, ctx.versionId, name);
  if (!coll) return apiError('Not found', 404);
  return apiResponse(ctx, { collection: project(coll) });
};

export const PATCH: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const name = params.name;
  if (!name) return apiError('Missing name');
  const existing = await vstore.collection(ctx.orgId, ctx.siteId, ctx.versionId, name);
  if (!existing) return apiError('Not found', 404);
  const body = (await request.json().catch(() => null)) as Partial<CollectionDef> | null;
  if (!body) return apiError('Invalid JSON body');
  const update = pickWritable(body);
  if (Object.keys(update).length === 0) return apiError('No writable fields in body');
  await vstore.writeCollection(ctx.orgId, ctx.siteId, ctx.versionId, name, update);
  const fresh = await vstore.collection(ctx.orgId, ctx.siteId, ctx.versionId, name);
  return apiResponse(ctx, { collection: fresh ? project(fresh) : null }, 200, body);
};

export const DELETE: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const name = params.name;
  if (!name) return apiError('Missing name');
  const url = new URL(request.url);
  if (url.searchParams.get('confirm') !== 'true') {
    // The schema doc can be re-created from the API, but the items go with
    // it — and we can't recover those. Force the caller to acknowledge.
    return apiError('Pass ?confirm=true to delete a collection (this removes all items too)', 400);
  }
  const existing = await vstore.collection(ctx.orgId, ctx.siteId, ctx.versionId, name);
  if (!existing) return apiError('Not found', 404);

  // Delete items first, then the schema. We do items via direct deleteDoc
  // since vstore.deleteCollectionItem expects a known itemId per call.
  const store = getStore();
  const items = await vstore.collectionItems(ctx.orgId, ctx.siteId, ctx.versionId, name);
  for (const item of items) {
    await store.deleteDoc(paths.collectionItem(ctx.orgId, ctx.siteId, name, item.id, ctx.versionId));
  }
  await store.deleteDoc(paths.collection(ctx.orgId, ctx.siteId, name, ctx.versionId));
  return apiResponse(ctx, { ok: true, deleted_items: items.length });
};
