// GET    /api/v1/sites/{siteId}/pages/{pageId}/blocks — read the block tree
// POST   /api/v1/sites/{siteId}/pages/{pageId}/blocks — add a block
// PATCH  /api/v1/sites/{siteId}/pages/{pageId}/blocks — update a block
// PUT    /api/v1/sites/{siteId}/pages/{pageId}/blocks — move a block
// DELETE /api/v1/sites/{siteId}/pages/{pageId}/blocks?block_id=… — remove
//
// Block-tree mutations through one endpoint. We keep the routes grouped
// because the mutations are tiny and share validation; one file beats
// five near-empty siblings.

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../../../lib/api-auth';
import { bodyShapeError } from '../../../../../../../../lib/api-body';
import { vstore } from '../../../../../../../../lib/version-store';
import {
  addBlock,
  updateBlock,
  moveBlock,
  removeBlock,
  findBlock,
  BlockMutationError,
} from '../../../../../../../../lib/block-mutations';
import {
  SCRIPT_WRITE_NOTICE,
  blockDataCarriesScript,
  resolveScriptFields,
} from '../../../../../../../../lib/block-script-gate';
import {
  mergeWorkingCopy,
  overlayWorkingCopy,
  readWorkingCopy,
} from '../../../../../../../../lib/working-copy';
import type { Block, Page } from '@typeroll/shared';

// Buffer model: mutations read from and write to the page's WORKING COPY
// (the draft layer). Nothing lands on the saved page until an explicit
// commit (commit_working_copy / `save: true` on update_page).
type Ctx = { orgId: string; siteId: string; versionId: string };

async function loadDraft(ctx: Ctx, pageId: string): Promise<{ page: Page; tree: Block[] } | null> {
  const page = await vstore.page(ctx.orgId, ctx.siteId, ctx.versionId, pageId);
  if (!page) return null;
  const wc = await readWorkingCopy(ctx, { kind: 'page', id: pageId });
  return {
    page: overlayWorkingCopy(page, wc),
    tree: (wc?.fields?.blocks as Block[] | undefined) ?? page.blocks ?? [],
  };
}

async function persistDraft(ctx: Ctx, pageId: string, blocks: Block[]): Promise<void> {
  await mergeWorkingCopy(ctx, { kind: 'page', id: pageId }, { blocks });
}

export const GET: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const pageId = params.pageId;
  if (!pageId) return apiError('Missing pageId');
  const draft = await loadDraft(ctx, pageId);
  if (!draft) return apiError('Not found', 404);
  // HTML-mode pages return their body too — useful for an agent picking
  // between rewriting in-place vs running the converter. Both shapes are
  // the DRAFT view (working copy overlaid).
  if (draft.page.content_mode === 'blocks') {
    return apiResponse(ctx, { content_mode: 'blocks', blocks: draft.tree });
  }
  return apiResponse(ctx, { content_mode: 'html', html_content: draft.page.html_content ?? '' });
};

export const POST: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const pageId = params.pageId;
  if (!pageId) return apiError('Missing pageId');
  const body = await request.json().catch(() => null) as {
    block?: Partial<Block>;
    parent_id?: string | null;
    slot_index?: number;
    position?: number;
  } | null;
  if (!body?.block?.type) return apiError('block.type is required');
  const shapeError = bodyShapeError(body, ['block', 'parent_id', 'slot_index', 'position']);
  if (shapeError) return apiError(shapeError, 400);

  const draft = await loadDraft(ctx, pageId);
  if (!draft) return apiError('Page not found', 404);

  try {
    // Bearer authority allows executable block-data fields; the notice is
    // what makes the stored JS visible. See lib/block-script-gate.ts.
    const warnings = blockDataCarriesScript(
      body.block.data,
      await resolveScriptFields(ctx.orgId, ctx.siteId, ctx.versionId, body.block.type),
    ) ? [SCRIPT_WRITE_NOTICE] : [];
    const result = addBlock(draft.tree, {
      block: { id: '', data: {}, ...body.block } as Block,
      parent_id: body.parent_id,
      slot_index: body.slot_index,
      position: body.position,
    });
    await persistDraft(ctx, pageId, result.blocks);
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
  const pageId = params.pageId;
  if (!pageId) return apiError('Missing pageId');
  const body = await request.json().catch(() => null) as {
    block_id?: string;
    data?: Record<string, unknown>;
    style_overrides?: Block['style_overrides'];
    responsive?: Block['responsive'];
  } | null;
  if (!body?.block_id) return apiError('block_id is required');
  const shapeError = bodyShapeError(body, ['block_id', 'data', 'style_overrides', 'responsive'], {
    requireOneOf: ['data', 'style_overrides', 'responsive'],
  });
  if (shapeError) return apiError(shapeError, 400);

  const draft = await loadDraft(ctx, pageId);
  if (!draft) return apiError('Page not found', 404);
  try {
    const found = findBlock(draft.tree, body.block_id);
    const warnings = blockDataCarriesScript(
      body.data,
      await resolveScriptFields(ctx.orgId, ctx.siteId, ctx.versionId, found?.block.type),
    ) ? [SCRIPT_WRITE_NOTICE] : [];
    const blocks = updateBlock(draft.tree, {
      block_id: body.block_id,
      data: body.data,
      style_overrides: body.style_overrides,
      responsive: body.responsive,
    });
    await persistDraft(ctx, pageId, blocks);
    return apiResponse(ctx, { blocks, ...(warnings.length ? { warnings } : {}) });
  } catch (e) {
    return mutError(e);
  }
};

export const PUT: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const pageId = params.pageId;
  if (!pageId) return apiError('Missing pageId');
  const body = await request.json().catch(() => null) as {
    block_id?: string;
    target_parent_id?: string | null;
    target_slot_index?: number;
    target_position?: number;
  } | null;
  if (!body?.block_id) return apiError('block_id is required');
  const shapeError = bodyShapeError(
    body,
    ['block_id', 'target_parent_id', 'target_slot_index', 'target_position'],
  );
  if (shapeError) return apiError(shapeError, 400);

  const draft = await loadDraft(ctx, pageId);
  if (!draft) return apiError('Page not found', 404);
  try {
    const blocks = moveBlock(draft.tree, {
      block_id: body.block_id,
      target_parent_id: body.target_parent_id,
      target_slot_index: body.target_slot_index,
      target_position: body.target_position,
    });
    await persistDraft(ctx, pageId, blocks);
    return apiResponse(ctx, { blocks });
  } catch (e) {
    return mutError(e);
  }
};

export const DELETE: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const pageId = params.pageId;
  if (!pageId) return apiError('Missing pageId');
  const url = new URL(request.url);
  const blockId = url.searchParams.get('block_id');
  if (!blockId) return apiError('block_id query param required');

  const draft = await loadDraft(ctx, pageId);
  if (!draft) return apiError('Page not found', 404);
  try {
    const blocks = removeBlock(draft.tree, blockId);
    await persistDraft(ctx, pageId, blocks);
    return apiResponse(ctx, { blocks });
  } catch (e) {
    return mutError(e);
  }
};

function mutError(e: unknown): Response {
  if (e instanceof BlockMutationError) {
    const status = e.code === 'not_found' ? 404 : 400;
    return apiError(e.message, status);
  }
  throw e;
}
