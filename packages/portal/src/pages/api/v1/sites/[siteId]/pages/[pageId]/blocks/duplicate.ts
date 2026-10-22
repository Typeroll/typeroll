// POST /api/v1/sites/{siteId}/pages/{pageId}/blocks/duplicate
//
// Clone a block (subtree included) and insert the copy directly after the
// original. Returns the duplicate's new id, with the whole tree or, for
// `response: "summary"`, the copy and where it sits. Used by the chat AI's
// `duplicate_block` tool and the MCP server's mirror — both call this
// endpoint rather than re-implement the mutation.

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../../../lib/api-auth';
import { bodyShapeError } from '../../../../../../../../lib/api-body';
import { vstore } from '../../../../../../../../lib/version-store';
import { duplicateBlock, BlockMutationError } from '../../../../../../../../lib/block-mutations';
import { mergeWorkingCopy, readWorkingCopy, workingCopyDiffers } from '../../../../../../../../lib/working-copy';
import { blockWriteResponse, blockWriteSummary } from '../../../../../../../../lib/block-write-response';
import type { Block } from '@typeroll/shared';

export const POST: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const pageId = params.pageId;
  if (!pageId) return apiError('Missing pageId');
  const body = await request.json().catch(() => null) as { block_id?: string; response?: string } | null;
  if (!body?.block_id) return apiError('block_id is required');
  const shapeError = bodyShapeError(body, ['block_id', 'response']);
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
  try {
    const { tree, duplicate_id } = duplicateBlock(source, body.block_id);
    const unsaved = workingCopyDiffers(page, await mergeWorkingCopy(ctx, wcTarget, { blocks: tree }));
    return apiResponse(ctx, {
      duplicate_id,
      ...(mode === 'summary' ? blockWriteSummary(tree, duplicate_id, unsaved) : { blocks: tree }),
    });
  } catch (e) {
    if (e instanceof BlockMutationError) {
      return apiError(e.message, e.code === 'not_found' ? 404 : 400);
    }
    throw e;
  }
};
