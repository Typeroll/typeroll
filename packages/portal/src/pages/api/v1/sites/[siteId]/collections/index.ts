// GET  /api/v1/sites/{siteId}/collections
// POST /api/v1/sites/{siteId}/collections     create a new collection
//
// Listing returns each collection with its field schema, routing fields
// (route_template, item_template_html), and slug/sort defaults so an agent
// can both discover and act on them in one round-trip.

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../lib/api-auth';
import { vstore } from '../../../../../../lib/version-store';
import { getStore } from '../../../../../../lib/datastore';
import { sanitizeBody } from '../../../../../../lib/sanitize';
import {
  effectiveRouteTemplate,
  getCollectionStarter,
  inferStarterKind,
  paths,
  type CollectionStarterKind,
} from '@typeroll/shared';
import type { Block, CollectionDef, FieldDefinition } from '@typeroll/shared';

const NAME_RE = /^[a-z][a-z0-9_-]{0,62}$/;

function project(c: CollectionDef): Record<string, unknown> {
  return {
    name: c.name,
    label_singular: c.label_singular,
    label_plural: c.label_plural,
    icon: c.icon,
    fields: c.fields,
    slug_field: c.slug_field,
    sort_field: c.sort_field,
    sort_dir: c.sort_dir,
    // route_template (raw stored value) — null/undefined means "never
    // set". Distinct from "" which means "explicitly opt out of per-
    // item URLs". effective_route_template is what the renderer will
    // actually use: the stored value if set, else the platform default
    // /{name}/{slug}. Surface both so an agent can detect collections
    // that were created before the default existed (route_template ===
    // null) and decide whether to leave them or set explicitly.
    route_template: c.route_template,
    effective_route_template: effectiveRouteTemplate(c),
    item_template_html: c.item_template_html,
    item_template_blocks: c.item_template_blocks,
    // Convenience flag: renders via blocks when item_template_blocks is
    // non-empty. The renderer prefers blocks over the HTML template, so
    // this tells the agent which path is live.
    renders_via_blocks: !!(c.item_template_blocks && c.item_template_blocks.length > 0),
  };
}

export const GET: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const colls = await vstore.collections(ctx.orgId, ctx.siteId, ctx.versionId);
  return apiResponse(ctx, { collections: colls.map(project) });
};

export const POST: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const body = (await request.json().catch(() => null)) as Partial<CollectionDef> | null;
  if (!body) return apiError('Invalid JSON body');

  const name = String(body.name ?? '').trim();
  if (!name || !NAME_RE.test(name)) {
    return apiError('name must be lowercase, start with a letter, [a-z0-9_-] (max 63)');
  }
  if (!body.label_singular || !body.label_plural) {
    return apiError('label_singular and label_plural required');
  }
  if (!Array.isArray(body.fields) || body.fields.length === 0) {
    return apiError('fields[] required (at least one)');
  }

  const existing = await vstore.collection(ctx.orgId, ctx.siteId, ctx.versionId, name);
  if (existing) return apiError(`Collection "${name}" already exists`, 409);

  // route_template default — items live under /{name}/{slug}. Set to ""
  // explicitly to opt out of per-item URLs (legacy listing-only behaviour).
  const route_template = typeof body.route_template === 'string' ? body.route_template : `/${name}/{slug}`;
  const item_template_html = typeof body.item_template_html === 'string'
    ? sanitizeBody(body.item_template_html)
    : undefined;

  // Block-mode item template — the new default. Resolution order:
  //   1. Caller passed `item_template_blocks` directly → use it.
  //   2. Caller passed `template_kind` → use the matching starter.
  //   3. Caller passed `item_template_html` → leave blocks empty
  //      (legacy HTML template wins; the renderer prefers blocks
  //      when both are set, so the HTML path is preserved).
  //   4. Otherwise → infer the kind from field shape and use the
  //      starter for it. This makes block-mode the default for
  //      new collections without forcing callers to know about it.
  type CreateBody = Partial<CollectionDef> & { template_kind?: CollectionStarterKind };
  const createBody = body as CreateBody;
  let item_template_blocks: Block[] | undefined =
    Array.isArray(createBody.item_template_blocks)
      ? (createBody.item_template_blocks as Block[])
      : undefined;
  if (!item_template_blocks && !item_template_html) {
    const kind = createBody.template_kind ?? inferStarterKind(body.fields as FieldDefinition[]);
    item_template_blocks = getCollectionStarter(kind);
  }

  const doc: Omit<CollectionDef, 'id'> = {
    name,
    label_singular: String(body.label_singular),
    label_plural: String(body.label_plural),
    icon: body.icon ? String(body.icon) : undefined,
    fields: body.fields as FieldDefinition[],
    slug_field: body.slug_field ?? 'slug',
    sort_field: body.sort_field,
    sort_dir: body.sort_dir === 'desc' ? 'desc' : body.sort_dir === 'asc' ? 'asc' : undefined,
    route_template,
    item_template_html,
    item_template_blocks,
    created_at: new Date().toISOString(),
  };
  await getStore().setDoc(paths.collection(ctx.orgId, ctx.siteId, name, ctx.versionId), doc);
  const fresh = await vstore.collection(ctx.orgId, ctx.siteId, ctx.versionId, name);
  return apiResponse(ctx, { collection: fresh ? project(fresh) : null }, 201, body);
};
