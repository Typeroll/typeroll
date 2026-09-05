// GET    /api/v1/sites/{siteId}/block-types/{typeId}  → fetch a type
// PATCH  /api/v1/sites/{siteId}/block-types/{typeId}  → update a custom type
// DELETE /api/v1/sites/{siteId}/block-types/{typeId}  → remove a custom type
//
// GET resolves core blocks (shipped in code) and custom/third-party
// (per-site collection) uniformly. PATCH and DELETE only operate on
// custom + third-party — attempting to mutate a core block returns 403.

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../lib/api-auth';
import { vstore } from '../../../../../../lib/version-store';
import { SCRIPT_WRITE_NOTICE } from '../../../../../../lib/block-script-gate';
import { CORE_BLOCK_TYPES, type BlockType } from '@typeroll/shared';

const WRITABLE = new Set<keyof BlockType>([
  'name', 'label', 'icon', 'category', 'container', 'slot_count', 'slot_labels',
  'schema', 'template', 'styles', 'script',
  'item_compatible', 'expand_to',
]);

function sanitizeWrite(input: Record<string, unknown>): Partial<BlockType> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(input)) {
    if (WRITABLE.has(k as keyof BlockType)) out[k] = input[k];
  }
  return out as Partial<BlockType>;
}

function validate(doc: Partial<BlockType>): string | null {
  if (doc.category !== undefined && !['layout', 'content', 'media', 'custom'].includes(doc.category)) {
    return 'category must be layout | content | media | custom';
  }
  if (
    doc.container !== undefined && doc.container !== true && doc.container !== false &&
    doc.container !== 'slots' && doc.container !== 'repeater' && doc.container !== 'conditional'
  ) {
    return 'container must be true | false | "slots" | "repeater" | "conditional"';
  }
  if (doc.schema !== undefined && !Array.isArray(doc.schema)) {
    return 'schema must be an array';
  }
  return null;
}

export const GET: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const typeId = params.typeId;
  if (!typeId) return apiError('Missing typeId');

  // Core block types ship in code, not the datastore — look there first.
  const fromCore = CORE_BLOCK_TYPES.find((b) => b.id === typeId);
  if (fromCore) return apiResponse(ctx, { block_type: fromCore });

  const doc = await vstore.blockType(ctx.orgId, ctx.siteId, ctx.versionId, typeId);
  if (!doc) return apiError('Not found', 404);
  return apiResponse(ctx, { block_type: doc });
};

export const PATCH: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const typeId = params.typeId;
  if (!typeId) return apiError('Missing typeId');
  if (CORE_BLOCK_TYPES.some((b) => b.id === typeId)) {
    return apiError('Core block types are managed in code, not editable via API', 403);
  }

  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return apiError('Invalid JSON', 400);
  const clean = sanitizeWrite(body);
  const err = validate(clean);
  if (err) return apiError(err, 400);

  const existing = await vstore.blockType(ctx.orgId, ctx.siteId, ctx.versionId, typeId);
  if (!existing) return apiError('Not found', 404);

  // `script` through an API key is allowed under the key holder's authority
  // (same trust level as scripts_head). The write is audit-logged by
  // apiResponse; the notice makes the stored JS visible to the operator.
  const warnings = clean.script !== undefined ? [SCRIPT_WRITE_NOTICE] : [];

  // Schema overrides replace wholesale (not deep-merged) — half-merged
  // schema arrays would silently corrupt blocks. Same goes for template
  // / styles. Everything else is shallow-merged.
  const merged: BlockType = { ...existing, ...clean };
  await vstore.writeBlockType(ctx.orgId, ctx.siteId, ctx.versionId, typeId, merged);
  return apiResponse(ctx, { ...merged, ...(warnings.length ? { warnings } : {}) });
};

export const DELETE: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const typeId = params.typeId;
  if (!typeId) return apiError('Missing typeId');
  if (CORE_BLOCK_TYPES.some((b) => b.id === typeId)) {
    return apiError('Core block types are managed in code, not removable via API', 403);
  }

  const existing = await vstore.blockType(ctx.orgId, ctx.siteId, ctx.versionId, typeId);
  if (!existing) return apiError('Not found', 404);

  await vstore.deleteBlockType(ctx.orgId, ctx.siteId, ctx.versionId, typeId);
  return apiResponse(ctx, { ok: true });
};
