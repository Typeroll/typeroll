// Generic block-tree mutation routes for any container — page, partial,
// or page template. URL: /api/v1/sites/{siteId}/containers/{kind}/{id}/blocks
//
//   GET    → read the block tree
//   POST   → add a block (body: { block, parent_id?, slot_index?, position? })
//   PATCH  → update a block's data (body: { block_id, data })
//   PUT    → move a block (body: { block_id, target_parent_id, ... })
//   DELETE → remove a block (?block_id=…)
//
// kind ∈ { page, partial, template }. The page kind is functionally
// equivalent to the legacy /pages/{pageId}/blocks endpoints — added here
// so MCP tools can dispatch on `target.kind` uniformly without branching
// on the URL pattern.
//
// All mutations route through block-containers.ts which handles the
// load + write boilerplate per kind (vstore for pages, datastore for
// partials/templates).

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../../../../lib/api-auth';
import { bodyShapeError } from '../../../../../../../../../lib/api-body';
import {
  loadContainer,
  writeContainer,
  ContainerError,
  type BlockContainerKind,
} from '../../../../../../../../../lib/block-containers';
import {
  addBlock,
  updateBlock,
  moveBlock,
  removeBlock,
  findBlock,
  BlockMutationError,
} from '../../../../../../../../../lib/block-mutations';
import {
  SCRIPT_WRITE_NOTICE,
  blockDataCarriesScript,
  resolveScriptFields,
} from '../../../../../../../../../lib/block-script-gate';
import type { Block } from '@typeroll/shared';

function parseTarget(params: Record<string, string | undefined>):
  | { ok: true; target: { kind: BlockContainerKind; id: string } }
  | { ok: false; response: Response }
{
  const kind = params.kind;
  const id = params.id;
  if (!kind || !id) return { ok: false, response: apiError('Missing kind or id', 400) };
  if (kind !== 'page' && kind !== 'partial' && kind !== 'template' && kind !== 'item_template') {
    return { ok: false, response: apiError(`kind must be page|partial|template|item_template, got "${kind}"`, 400) };
  }
  return { ok: true, target: { kind, id } };
}

function mutError(e: unknown): Response {
  if (e instanceof ContainerError) return apiError(e.message, e.status);
  if (e instanceof BlockMutationError) {
    const status = e.code === 'not_found' ? 404 : 400;
    return apiError(e.message, status);
  }
  throw e;
}

export const GET: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const t = parseTarget(params as Record<string, string | undefined>);
  if (!t.ok) return t.response;
  try {
    // Pages/partials return the DRAFT view (working copy overlaid) — the
    // same tree the mutations below operate on.
    const loaded = await loadContainer(t.target, ctx);
    return apiResponse(ctx, { content_mode: 'blocks', blocks: loaded.blocks });
  } catch (e) {
    return mutError(e);
  }
};

export const POST: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const t = parseTarget(params as Record<string, string | undefined>);
  if (!t.ok) return t.response;
  const body = await request.json().catch(() => null) as {
    block?: Partial<Block>;
    parent_id?: string | null;
    slot_index?: number;
    position?: number;
    working_copy?: boolean;
  } | null;
  if (!body?.block?.type) return apiError('block.type is required', 400);
  const shapeError = bodyShapeError(body, ['block', 'parent_id', 'slot_index', 'position', 'working_copy']);
  if (shapeError) return apiError(shapeError, 400);
  try {
    const loaded = await loadContainer(t.target, ctx);
    // Executable block-data fields are allowed under the key holder's
    // authority (same trust level as scripts_head) — the notice is what
    // makes the stored JS visible to the operator. See block-script-gate.ts.
    const warnings = blockDataCarriesScript(
      body.block.data,
      await resolveScriptFields(ctx.orgId, ctx.siteId, ctx.versionId, body.block.type),
    ) ? [SCRIPT_WRITE_NOTICE] : [];
    const result = addBlock(loaded.blocks, {
      block: { id: '', data: {}, ...body.block } as Block,
      parent_id: body.parent_id,
      slot_index: body.slot_index,
      position: body.position,
    });
    await writeContainer(t.target, result.blocks, ctx, loaded.raw);
    return apiResponse(ctx, {
      added_id: result.added_id, blocks: result.blocks,
      ...(warnings.length ? { warnings } : {}),
    });
  } catch (e) {
    return mutError(e);
  }
};

export const PATCH: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const t = parseTarget(params as Record<string, string | undefined>);
  if (!t.ok) return t.response;
  const body = await request.json().catch(() => null) as {
    block_id?: string;
    data?: Record<string, unknown>;
    style_overrides?: Block['style_overrides'];
    responsive?: Block['responsive'];
    working_copy?: boolean;
  } | null;
  if (!body?.block_id) return apiError('block_id is required', 400);
  const shapeError = bodyShapeError(body, ['block_id', 'data', 'style_overrides', 'responsive', 'working_copy'], {
    requireOneOf: ['data', 'style_overrides', 'responsive'],
  });
  if (shapeError) return apiError(shapeError, 400);
  try {
    const loaded = await loadContainer(t.target, ctx);
    // The patch carries only data, so the type comes from the tree.
    const found = findBlock(loaded.blocks, body.block_id);
    const warnings = blockDataCarriesScript(
      body.data,
      await resolveScriptFields(ctx.orgId, ctx.siteId, ctx.versionId, found?.block.type),
    ) ? [SCRIPT_WRITE_NOTICE] : [];
    const blocks = updateBlock(loaded.blocks, {
      block_id: body.block_id,
      data: body.data,
      style_overrides: body.style_overrides,
      responsive: body.responsive,
    });
    await writeContainer(t.target, blocks, ctx, loaded.raw);
    return apiResponse(ctx, { blocks, ...(warnings.length ? { warnings } : {}) });
  } catch (e) {
    return mutError(e);
  }
};

export const PUT: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const t = parseTarget(params as Record<string, string | undefined>);
  if (!t.ok) return t.response;
  const body = await request.json().catch(() => null) as {
    block_id?: string;
    target_parent_id?: string | null;
    target_slot_index?: number;
    target_position?: number;
    working_copy?: boolean;
  } | null;
  if (!body?.block_id) return apiError('block_id is required', 400);
  const shapeError = bodyShapeError(
    body,
    ['block_id', 'target_parent_id', 'target_slot_index', 'target_position', 'working_copy'],
  );
  if (shapeError) return apiError(shapeError, 400);
  try {
    const loaded = await loadContainer(t.target, ctx);
    const blocks = moveBlock(loaded.blocks, {
      block_id: body.block_id,
      target_parent_id: body.target_parent_id,
      target_slot_index: body.target_slot_index,
      target_position: body.target_position,
    });
    await writeContainer(t.target, blocks, ctx, loaded.raw);
    return apiResponse(ctx, { blocks });
  } catch (e) {
    return mutError(e);
  }
};

export const DELETE: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const t = parseTarget(params as Record<string, string | undefined>);
  if (!t.ok) return t.response;
  const url = new URL(request.url);
  const blockId = url.searchParams.get('block_id');
  if (!blockId) return apiError('block_id query param required', 400);
  try {
    const loaded = await loadContainer(t.target, ctx);
    const blocks = removeBlock(loaded.blocks, blockId);
    await writeContainer(t.target, blocks, ctx, loaded.raw);
    return apiResponse(ctx, { blocks });
  } catch (e) {
    return mutError(e);
  }
};
