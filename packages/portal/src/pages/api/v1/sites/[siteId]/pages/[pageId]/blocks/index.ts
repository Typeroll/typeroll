// GET    /api/v1/sites/{siteId}/pages/{pageId}/blocks — read the block tree
// POST   /api/v1/sites/{siteId}/pages/{pageId}/blocks — add a block
// PATCH  /api/v1/sites/{siteId}/pages/{pageId}/blocks — update a block
// PUT    /api/v1/sites/{siteId}/pages/{pageId}/blocks — move a block
// DELETE /api/v1/sites/{siteId}/pages/{pageId}/blocks?block_id=…[&response=summary] — remove
//
// Block-tree mutations through one endpoint. We keep the routes grouped
// because the mutations are tiny and share validation; one file beats
// five near-empty siblings.
//
// Writes answer with the whole tree by default. `response: "summary"` (body
// key or query parameter) answers with the changed block, where it sits and
// has_unsaved_changes instead (block-write-response.ts).

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../../../lib/api-auth';
import { bodyShapeError } from '../../../../../../../../lib/api-body';
import { vstore } from '../../../../../../../../lib/version-store';
import {
  addBlock,
  updateBlock,
  moveBlock,
  removeBlock,
  BlockMutationError,
} from '../../../../../../../../lib/block-mutations';
import {
  mergeWorkingCopy,
  overlayWorkingCopy,
  readWorkingCopy,
  workingCopyDiffers,
} from '../../../../../../../../lib/working-copy';
import { blockLocation, blockWriteResponse, blockWriteSummary } from '../../../../../../../../lib/block-write-response';
import type { Block, Page } from '@typeroll/shared';
import {
  addBlockUnknownFields,
  singleBlockWriteWarnings,
  siteBlockRegistry,
  unknownFieldsBody,
  updateBlockUnknownFields,
} from '../../../../../../../../lib/block-write-warnings';

// Buffer model: mutations read from and write to the page's WORKING COPY
// (the draft layer). Nothing lands on the saved page until an explicit
// commit (commit_working_copy / `save: true` on update_page).
type Ctx = { orgId: string; siteId: string; versionId: string };

async function loadDraft(ctx: Ctx, pageId: string): Promise<{ page: Page; saved: Page; tree: Block[] } | null> {
  const page = await vstore.page(ctx.orgId, ctx.siteId, ctx.versionId, pageId);
  if (!page) return null;
  const wc = await readWorkingCopy(ctx, { kind: 'page', id: pageId });
  return {
    page: overlayWorkingCopy(page, wc),
    saved: page,
    tree: (wc?.fields?.blocks as Block[] | undefined) ?? page.blocks ?? [],
  };
}

/** Write the tree to the working copy; true when it now differs from the saved page. */
async function persistDraft(ctx: Ctx, pageId: string, blocks: Block[], saved: Page): Promise<boolean> {
  return workingCopyDiffers(saved, await mergeWorkingCopy(ctx, { kind: 'page', id: pageId }, { blocks }));
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
    response?: string;
  } | null;
  if (!body?.block?.type) return apiError('block.type is required');
  if (body.block.responsive !== undefined) {
    return apiError('block.responsive is not a rendered field. Put breakpoint values in block.data (for example data.cols={mobile:1,tablet:2,desktop:3}) or use the /responsive endpoint.', 400);
  }
  const shapeError = bodyShapeError(body, ['block', 'parent_id', 'slot_index', 'position', 'response']);
  if (shapeError) return apiError(shapeError, 400);
  const mode = blockWriteResponse(request, body);
  if (typeof mode !== 'string') return apiError(mode.error, 400);

  const draft = await loadDraft(ctx, pageId);
  if (!draft) return apiError('Page not found', 404);
  const registry = await siteBlockRegistry(ctx);
  const unknown = addBlockUnknownFields(body.block, registry);
  if (unknown.length) return apiResponse(ctx, unknownFieldsBody(unknown), 400, body);

  try {
    const result = addBlock(draft.tree, {
      block: { id: '', data: {}, ...body.block } as Block,
      parent_id: body.parent_id,
      slot_index: body.slot_index,
      position: body.position,
    });
    const unsaved = await persistDraft(ctx, pageId, result.blocks, draft.saved);
    const warnings = await singleBlockWriteWarnings(ctx, result.blocks, result.added_id, {
      data: body.block.data, style_overrides: body.block.style_overrides,
    }, registry);
    return apiResponse(ctx, {
      added_id: result.added_id,
      ...(mode === 'summary' ? blockWriteSummary(result.blocks, result.added_id, unsaved) : { blocks: result.blocks }),
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
    response?: string;
  } | null;
  if (!body?.block_id) return apiError('block_id is required');
  if (body && 'responsive' in body) {
    return apiError('responsive is not writable here. Put breakpoint values in data or use the /responsive endpoint.', 400);
  }
  const shapeError = bodyShapeError(body, ['block_id', 'data', 'style_overrides', 'response'], {
    requireOneOf: ['data', 'style_overrides'],
  });
  if (shapeError) return apiError(shapeError, 400);
  const mode = blockWriteResponse(request, body);
  if (typeof mode !== 'string') return apiError(mode.error, 400);
  if (body.data !== undefined && (!body.data || typeof body.data !== 'object' || Array.isArray(body.data))) {
    return apiError('data must be an object of field values; a null value removes that key.', 400);
  }

  const draft = await loadDraft(ctx, pageId);
  if (!draft) return apiError('Page not found', 404);
  // A key no field of the block's type declares would be stored and never
  // rendered; reject it, naming where it probably belongs.
  const registry = await siteBlockRegistry(ctx);
  const unknown = updateBlockUnknownFields(draft.tree, body.block_id, body.data, registry);
  if (unknown.length) return apiResponse(ctx, unknownFieldsBody(unknown), 400, body);
  try {
    const blocks = updateBlock(draft.tree, {
      block_id: body.block_id,
      data: body.data,
      style_overrides: body.style_overrides,
      null_removes: true,
    });
    const unsaved = await persistDraft(ctx, pageId, blocks, draft.saved);
    // A misspelled override is stored, returned and built without comment.
    // The caller cannot read our logs, so it travels in the body.
    // Field values the schema will not render travel the same way.
    const overrideWarnings = await singleBlockWriteWarnings(ctx, blocks, body.block_id, body, registry);
    return apiResponse(ctx, {
      ...(overrideWarnings.length ? { warnings: overrideWarnings } : {}),
      ...(mode === 'summary' ? blockWriteSummary(blocks, body.block_id, unsaved) : { blocks }),
    });
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
    response?: string;
  } | null;
  if (!body?.block_id) return apiError('block_id is required');
  const shapeError = bodyShapeError(
    body,
    ['block_id', 'target_parent_id', 'target_slot_index', 'target_position', 'response'],
  );
  if (shapeError) return apiError(shapeError, 400);
  const mode = blockWriteResponse(request, body);
  if (typeof mode !== 'string') return apiError(mode.error, 400);

  const draft = await loadDraft(ctx, pageId);
  if (!draft) return apiError('Page not found', 404);
  try {
    const blocks = moveBlock(draft.tree, {
      block_id: body.block_id,
      target_parent_id: body.target_parent_id,
      target_slot_index: body.target_slot_index,
      target_position: body.target_position,
    });
    const unsaved = await persistDraft(ctx, pageId, blocks, draft.saved);
    return apiResponse(ctx, mode === 'summary' ? blockWriteSummary(blocks, body.block_id, unsaved) : { blocks });
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
  const mode = blockWriteResponse(request);
  if (typeof mode !== 'string') return apiError(mode.error, 400);

  const draft = await loadDraft(ctx, pageId);
  if (!draft) return apiError('Page not found', 404);
  try {
    const location = blockLocation(draft.tree, blockId);
    const blocks = removeBlock(draft.tree, blockId);
    const unsaved = await persistDraft(ctx, pageId, blocks, draft.saved);
    return apiResponse(ctx, mode === 'summary' ? { removed_id: blockId, ...location, has_unsaved_changes: unsaved } : { blocks });
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
