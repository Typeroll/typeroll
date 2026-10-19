// POST /api/v1/sites/{siteId}/containers/{kind}/{id}/blocks/duplicate
//
// Clone a block (subtree included) inside any container — page, partial,
// or page template. Returns the duplicate's new id, with the whole tree or,
// for `response: "summary"`, the copy and where it sits.

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../../../../lib/api-auth';
import { bodyShapeError } from '../../../../../../../../../lib/api-body';
import {
  loadContainer, writeContainer, ContainerError,
  type BlockContainerKind,
} from '../../../../../../../../../lib/block-containers';
import { duplicateBlock, BlockMutationError } from '../../../../../../../../../lib/block-mutations';
import { blockWriteResponse, blockWriteSummary } from '../../../../../../../../../lib/block-write-response';

export const POST: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const kind = params.kind;
  const id = params.id;
  if (!kind || !id) return apiError('Missing kind or id', 400);
  if (kind !== 'page' && kind !== 'partial' && kind !== 'template') {
    return apiError(`kind must be page|partial|template, got "${kind}"`, 400);
  }
  const target = { kind: kind as BlockContainerKind, id };

  const body = await request.json().catch(() => null) as {
    block_id?: string;
    working_copy?: boolean;
    response?: string;
  } | null;
  if (!body?.block_id) return apiError('block_id is required', 400);
  const shapeError = bodyShapeError(body, ['block_id', 'working_copy', 'response']);
  if (shapeError) return apiError(shapeError, 400);
  const mode = blockWriteResponse(request, body);
  if (typeof mode !== 'string') return apiError(mode.error, 400);

  try {
    const loaded = await loadContainer(target, ctx);
    const { tree, duplicate_id } = duplicateBlock(loaded.blocks, body.block_id);
    const written = await writeContainer(target, tree, ctx, loaded.raw);
    return apiResponse(ctx, {
      duplicate_id,
      ...(mode === 'summary' ? blockWriteSummary(tree, duplicate_id, written.has_unsaved_changes) : { blocks: tree }),
    });
  } catch (e) {
    if (e instanceof ContainerError) return apiError(e.message, e.status);
    if (e instanceof BlockMutationError) {
      return apiError(e.message, e.code === 'not_found' ? 404 : 400);
    }
    throw e;
  }
};
