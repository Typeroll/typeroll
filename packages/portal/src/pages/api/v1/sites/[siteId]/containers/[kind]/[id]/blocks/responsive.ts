// POST /api/v1/sites/{siteId}/containers/{kind}/{id}/blocks/responsive
//
// Set a per-breakpoint value on a single field of one block, in any
// container (page, partial, or page template).
//
// A field no field of the block's type declares is rejected (unknown_field).
// The answer is the whole tree, or for `response: "summary"` the block and
// where it sits (block-write-response.ts).

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../../../../lib/api-auth';
import { bodyShapeError } from '../../../../../../../../../lib/api-body';
import {
  loadContainer, writeContainer, ContainerError,
  type BlockContainerKind,
} from '../../../../../../../../../lib/block-containers';
import { setBlockResponsiveField, BlockMutationError } from '../../../../../../../../../lib/block-mutations';
import { blockWriteResponse, blockWriteSummary } from '../../../../../../../../../lib/block-write-response';
import { siteBlockRegistry, unknownFieldsBody, updateBlockUnknownFields } from '../../../../../../../../../lib/block-write-warnings';

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
    field?: string;
    value?: unknown;
    working_copy?: boolean;
    response?: string;
  } | null;
  if (!body?.block_id) return apiError('block_id is required', 400);
  if (!body.field) return apiError('field is required', 400);
  const shapeError = bodyShapeError(body, ['block_id', 'field', 'value', 'working_copy', 'response']);
  if (shapeError) return apiError(shapeError, 400);
  const mode = blockWriteResponse(request, body);
  if (typeof mode !== 'string') return apiError(mode.error, 400);

  try {
    const loaded = await loadContainer(target, ctx);
    const unknown = updateBlockUnknownFields(loaded.blocks, body.block_id, { [body.field]: body.value ?? '' }, await siteBlockRegistry(ctx));
    if (unknown.length) return apiResponse(ctx, unknownFieldsBody(unknown), 400, body);
    const blocks = setBlockResponsiveField(loaded.blocks, {
      block_id: body.block_id,
      field: body.field,
      value: body.value,
    });
    const written = await writeContainer(target, blocks, ctx, loaded.raw);
    return apiResponse(ctx, mode === 'summary' ? blockWriteSummary(blocks, body.block_id, written.has_unsaved_changes) : { blocks });
  } catch (e) {
    if (e instanceof ContainerError) return apiError(e.message, e.status);
    if (e instanceof BlockMutationError) {
      return apiError(e.message, e.code === 'not_found' ? 404 : 400);
    }
    throw e;
  }
};
