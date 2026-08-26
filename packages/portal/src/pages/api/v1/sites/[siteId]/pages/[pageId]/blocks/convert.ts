// POST /api/v1/sites/{siteId}/pages/{pageId}/blocks/convert
//
// Convert an HTML-mode page to blocks. Heuristic — falls through to
// `core/prose` blocks for any content the converter can't classify.
//
// Body: { dry_run?: boolean, switch_mode?: boolean }
//  - dry_run = true (default): returns the proposed block tree without writing
//  - switch_mode = true: when applying (dry_run=false), also flip
//    `content_mode` to 'blocks'. Otherwise the page stays HTML and the
//    converted blocks are dropped onto `page.blocks` but the renderer
//    still uses html_content. Useful for previewing without commitment.

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../../../lib/api-auth';
import { bodyShapeError } from '../../../../../../../../lib/api-body';
import { vstore } from '../../../../../../../../lib/version-store';
import { htmlToBlocks } from '../../../../../../../../lib/html-to-blocks';

export const POST: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const pageId = params.pageId;
  if (!pageId) return apiError('Missing pageId');

  const body = await request.json().catch(() => null) as {
    dry_run?: boolean;
    switch_mode?: boolean;
  } | null;
  if (body) {
    const shapeError = bodyShapeError(body, ['dry_run', 'switch_mode']);
    if (shapeError) return apiError(shapeError, 400);
  }
  const dryRun = body?.dry_run ?? true;
  const switchMode = body?.switch_mode ?? false;

  const page = await vstore.page(ctx.orgId, ctx.siteId, ctx.versionId, pageId);
  if (!page) return apiError('Page not found', 404);
  if (!page.html_content) {
    return apiResponse(ctx, {
      blocks: [],
      summary: [],
      notes: ['Page has no html_content to convert.'],
      applied: false,
    });
  }

  const result = htmlToBlocks(page.html_content);

  if (dryRun) {
    return apiResponse(ctx, {
      ...result,
      applied: false,
    });
  }

  const update: Record<string, unknown> = { blocks: result.blocks };
  if (switchMode) update.content_mode = 'blocks';
  await vstore.writePage(ctx.orgId, ctx.siteId, ctx.versionId, pageId, update);

  return apiResponse(ctx, {
    ...result,
    applied: true,
    switched_mode: switchMode,
  });
};
