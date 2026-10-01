// POST /api/v1/sites/{siteId}/pages/{pageId}/blocks/convert-prose
//   { block_id }                       preview: the blocks a text block would become
//   { block_id, accept: <fingerprint> } replace the text block in the draft
//
// Turns a text (core/prose) block that holds headings, classed paragraphs,
// lists or images into separate blocks that styles and the editor can
// address. Writes go to the page's working copy, like other block mutations.

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../../../lib/api-auth';
import { bodyShapeError } from '../../../../../../../../lib/api-body';
import { vstore } from '../../../../../../../../lib/version-store';
import { mergeWorkingCopy, readWorkingCopy } from '../../../../../../../../lib/working-copy';
import { applyProseConversion, previewProseConversion, ProseConvertError } from '../../../../../../../../lib/prose-convert';
import type { Block } from '@typeroll/shared';

export const POST: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const pageId = params.pageId;
  if (!pageId) return apiError('Missing pageId');
  const body = await request.json().catch(() => null) as { block_id?: unknown; accept?: unknown } | null;
  if (!body || typeof body !== 'object') return apiError('Body must be a JSON object');
  const shapeError = bodyShapeError(body, ['block_id', 'accept']);
  if (shapeError) return apiError(shapeError, 400);
  if (typeof body.block_id !== 'string' || !body.block_id) return apiError('block_id is required');
  if (body.accept !== undefined && typeof body.accept !== 'string') return apiError('accept must be the preview fingerprint');

  const page = await vstore.page(ctx.orgId, ctx.siteId, ctx.versionId, pageId);
  if (!page) return apiError('Page not found', 404);
  const wc = await readWorkingCopy(ctx, { kind: 'page', id: pageId });
  const tree = (wc?.fields?.blocks as Block[] | undefined) ?? page.blocks ?? [];
  try {
    if (!body.accept) return apiResponse(ctx, { ...previewProseConversion(tree, body.block_id), applied: false });
    const { blocks, conversion } = applyProseConversion(tree, body.block_id, body.accept);
    await mergeWorkingCopy(ctx, { kind: 'page', id: pageId }, { blocks });
    return apiResponse(ctx, { ...conversion, blocks, applied: true });
  } catch (e) {
    if (e instanceof ProseConvertError) return apiError(e.message, e.status);
    throw e;
  }
};
