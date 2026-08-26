// GET  /api/v1/sites/{siteId}/block-types
// POST /api/v1/sites/{siteId}/block-types  → create a custom block type
//
// GET lists every block type usable on this site: core (always available,
// shipped in code) + custom (created in the portal) + third-party
// (imported from .tcblocks packages).
//
// POST creates a new custom block type. Origin is auto-stamped to 'ai'
// when the request originates from a request flagged as AI (the MCP tool
// adapter sets it via `?origin=ai`), otherwise 'user'. Either way, the
// type is editable through the portal UI by org members. Body fields are
// whitelisted — anything outside WRITABLE is silently dropped.
//
// PATCH + DELETE per-type live in [typeId].ts.

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../lib/api-auth';
import { getStore } from '../../../../../../lib/datastore';
import { SCRIPT_WRITE_NOTICE } from '../../../../../../lib/block-script-gate';
import {
  CORE_BLOCK_TYPES, paths,
  type BlockOrigin, type BlockType, type FieldDefinition,
} from '@typeroll/shared';

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
  if (doc.name !== undefined && !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(doc.name)) {
    return 'name must be lowercase kebab/underscore (1-64 chars)';
  }
  if (doc.category !== undefined && !['layout', 'content', 'media', 'custom'].includes(doc.category)) {
    return 'category must be layout | content | media | custom';
  }
  if (
    doc.container !== undefined && doc.container !== true && doc.container !== false &&
    doc.container !== 'slots' && doc.container !== 'repeater' && doc.container !== 'conditional'
  ) {
    return 'container must be true | false | "slots" | "repeater" | "conditional"';
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

export const GET: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const url = new URL(request.url);
  const includeCore = url.searchParams.get('include_core') !== 'false';

  const custom = await getStore().listDocs<BlockType>(
    paths.blockTypes(ctx.orgId, ctx.siteId, ctx.versionId),
  );
  const merged: BlockType[] = includeCore
    ? [
        // template_content_slot is a marker block used inside
        // PageTemplate composition, not a content block — hide it
        // from the discovery list. Templates UI exposes it separately.
        ...CORE_BLOCK_TYPES.filter((b) => b.id !== 'template_content_slot'),
        ...custom,
      ]
    : custom;

  return apiResponse(ctx, { block_types: merged });
};

export const POST: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return apiError('Invalid JSON', 400);
  const clean = sanitizeWrite(body);
  const err = validate(clean);
  if (err) return apiError(err, 400);
  if (!clean.name) return apiError('name is required', 400);

  // `script` through an API key is allowed under the key holder's authority
  // (same trust level as scripts_head). The write is audit-logged by
  // apiResponse; the notice makes the stored JS visible to the operator.
  const warnings = clean.script !== undefined ? [SCRIPT_WRITE_NOTICE] : [];

  // Origin: 'ai' when the AI surface is the caller (tool definition
  // attaches ?origin=ai), 'user' otherwise. Either way the type lands
  // in the per-site datastore — core remains code-only.
  const url = new URL(request.url);
  const originHint = url.searchParams.get('origin');
  const origin: BlockOrigin = originHint === 'ai' ? 'ai' : 'user';

  const id = clean.name as string;
  const docPath = `${paths.blockTypes(ctx.orgId, ctx.siteId, ctx.versionId)}/${id}`;
  const existing = await getStore().getDoc<BlockType>(docPath);
  if (existing) return apiError(`Block type "${id}" already exists`, 409);

  const doc: BlockType = {
    id,
    name: clean.name as string,
    label: (clean.label as string) ?? clean.name as string,
    icon: clean.icon as string | undefined,
    category: (clean.category as BlockType['category']) ?? 'custom',
    container: (clean.container as BlockType['container']) ?? false,
    slot_count: clean.slot_count as number | undefined,
    slot_labels: clean.slot_labels as string[] | undefined,
    item_compatible: clean.item_compatible as boolean | undefined,
    expand_to: clean.expand_to as BlockType['expand_to'],
    schema: (clean.schema as FieldDefinition[]) ?? [],
    template: clean.template as string | undefined,
    styles: clean.styles as string | undefined,
    script: clean.script as string | undefined,
    origin,
    created_at: new Date().toISOString(),
  };
  await getStore().setDoc(docPath, doc);
  return apiResponse(ctx, { ...doc, ...(warnings.length ? { warnings } : {}) });
};
