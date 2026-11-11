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
import { bodyShapeError, containerTargetError } from '../../../../../../../../lib/api-body';
import { vstore } from '../../../../../../../../lib/version-store';
import { setBlockResponsiveField, BlockMutationError } from '../../../../../../../../lib/block-mutations';
import { mergeWorkingCopy, readWorkingCopy, workingCopyDiffers } from '../../../../../../../../lib/working-copy';
import { blockWriteAnswer, blockWriteResponse } from '../../../../../../../../lib/block-write-response';
import { siteBlockRegistry, unknownFieldsBody, updateBlockUnknownFields, updatedBlockInvalidFields } from '../../../../../../../../lib/block-write-warnings';
import { invalidFieldValuesBody, type Block } from '@typeroll/shared';
import { headingAnchorWarnings } from '../../../../../../../../lib/heading-anchor-warnings';

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
  const targetError = containerTargetError(ctx.siteId, (body as { target?: unknown } | null)?.target, '/responsive');
  if (targetError) return apiError(targetError, 400);
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
  const registry = await siteBlockRegistry(ctx);
  const unknown = updateBlockUnknownFields(source, body.block_id, { [body.field]: body.value ?? '' }, registry);
  if (unknown.length) return apiResponse(ctx, unknownFieldsBody(unknown), 400, body);
  try {
    const blocks = setBlockResponsiveField(source, {
      block_id: body.block_id,
      field: body.field,
      value: body.value,
    });
    const invalid = updatedBlockInvalidFields(source, blocks, body.block_id, registry);
    if (invalid.length) return apiResponse(ctx, invalidFieldValuesBody(invalid), 400, body);
    const unsaved = workingCopyDiffers(page, await mergeWorkingCopy(ctx, wcTarget, { blocks }));
    // A scalar value can set any declared field, the heading text included.
    const warnings = await headingAnchorWarnings(ctx, page, { content_mode: 'blocks', blocks: source }, { content_mode: 'blocks', blocks });
    return apiResponse(ctx, {
      ...blockWriteAnswer(mode, blocks, body.block_id, unsaved),
      ...(warnings.length ? { warnings } : {}),
    });
  } catch (e) {
    if (e instanceof BlockMutationError) {
      return apiError(e.message, e.code === 'not_found' ? 404 : 400);
    }
    throw e;
  }
};
