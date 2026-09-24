// POST /api/v1/sites/{siteId}/pages/{pageId}/blocks/convert
//
// Preview the heuristic HTML→blocks conversion. This route never writes.
// `dry_run: false` and `switch_mode: true` are refused so an API client
// cannot change content_mode and replace the body in one call.
// A person accepts a preview from the page editor.

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../../../lib/api-auth';
import { bodyShapeError } from '../../../../../../../../lib/api-body';
import { vstore } from '../../../../../../../../lib/version-store';
import { AUTOMATIC_CONVERSION_REFUSAL, htmlToBlocks } from '../../../../../../../../lib/html-to-blocks';

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
  if (body?.dry_run === false || body?.switch_mode) {
    return apiError(AUTOMATIC_CONVERSION_REFUSAL, 400);
  }

  const page = await vstore.page(ctx.orgId, ctx.siteId, ctx.versionId, pageId);
  if (!page) return apiError('Page not found', 404);
  if (!page.html_content) {
    return apiResponse(ctx, {
      blocks: [],
      summary: [],
      notes: ['Page has no html_content to convert.'],
      unconverted: [],
      applied: false,
    });
  }

  const result = htmlToBlocks(page.html_content);
  return apiResponse(ctx, {
    ...result,
    applied: false,
  });
};
