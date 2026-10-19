// POST /api/v1/sites/{siteId}/pages/{pageId}/blocks/responsive
//
// Set a per-breakpoint value on one field of one block. Body shape:
//   { block_id, field, value }
//
// `value` is either a scalar (applies to every breakpoint and clears any
// prior responsive shape) or a partial object with mobile/tablet/laptop/
// desktop/wide keys. The mutation merges partial objects into existing
// per-bp values rather than replacing wholesale, so iterative tweaks
// from the AI don't accidentally wipe other breakpoints.
//
// A field no field of the block's type declares is rejected (unknown_field).
// The answer is the whole tree, or for `response: "summary"` the block and
// where it sits (block-write-response.ts).

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../../../lib/api-auth';
import { bodyShapeError } from '../../../../../../../../lib/api-body';
import { vstore } from '../../../../../../../../lib/version-store';
import { setBlockResponsiveField, BlockMutationError } from '../../../../../../../../lib/block-mutations';
import { mergeWorkingCopy, readWorkingCopy, workingCopyDiffers } from '../../../../../../../../lib/working-copy';
import { blockWriteResponse, blockWriteSummary } from '../../../../../../../../lib/block-write-response';
import { siteBlockRegistry, unknownFieldsBody, updateBlockUnknownFields } from '../../../../../../../../lib/block-write-warnings';
import type { Block } from '@typeroll/shared';

export const POST: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const pageId = params.pageId;
  if (!pageId) return apiError('Missing pageId');
  const body = await request.json().catch(() => null) as {
    block_id?: string;
    field?: string;
    value?: unknown;
    response?: string;
  } | null;
  if (!body?.block_id) return apiError('block_id is required');
  if (!body.field) return apiError('field is required');
  const shapeError = bodyShapeError(body, ['block_id', 'field', 'value', 'response']);
  if (shapeError) return apiError(shapeError, 400);
  const mode = blockWriteResponse(request, body);
  if (typeof mode !== 'string') return apiError(mode.error, 400);

  const page = await vstore.page(ctx.orgId, ctx.siteId, ctx.versionId, pageId);
  if (!page) return apiError('Page not found', 404);
  if (page.content_mode !== 'blocks') {
    return apiError(`Page is in ${page.content_mode}-mode`, 400);
  }
  // Buffer model: mutate the working copy's tree; commit is explicit.
  const wcTarget = { kind: 'page', id: pageId } as const;
  const wc = await readWorkingCopy(ctx, wcTarget);
  const source = (wc?.fields?.blocks as Block[] | undefined) ?? page.blocks ?? [];
  const unknown = updateBlockUnknownFields(source, body.block_id, { [body.field]: body.value ?? '' }, await siteBlockRegistry(ctx));
  if (unknown.length) return apiResponse(ctx, unknownFieldsBody(unknown), 400, body);
  try {
    const blocks = setBlockResponsiveField(source, {
      block_id: body.block_id,
      field: body.field,
      value: body.value,
    });
    const unsaved = workingCopyDiffers(page, await mergeWorkingCopy(ctx, wcTarget, { blocks }));
    return apiResponse(ctx, mode === 'summary' ? blockWriteSummary(blocks, body.block_id, unsaved) : { blocks });
  } catch (e) {
    if (e instanceof BlockMutationError) {
      return apiError(e.message, e.code === 'not_found' ? 404 : 400);
    }
    throw e;
  }
};
