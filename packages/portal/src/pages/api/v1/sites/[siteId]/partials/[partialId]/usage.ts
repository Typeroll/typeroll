// GET /api/v1/sites/{siteId}/partials/{partialId}/usage
//
// What references this global block: pages (core/global_block blocks or
// <x-include name="…">), page templates, and other partials (header,
// footer and global blocks that nest it), saved or in a draft. Header and
// footer report auto_injected: true and return the full page list (they're
// not referenced — the renderer injects them everywhere).

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../../lib/api-auth';
import { getBlockUsage } from '../../../../../../../lib/partials-usage';
import { vstore } from '../../../../../../../lib/version-store';
import { pathParam } from '../../../../../../../lib/path-param';

export const GET: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const partialId = pathParam(params.partialId);
  if (!partialId) return apiError('Missing partialId');

  if (partialId === 'header' || partialId === 'footer') {
    const pages = await vstore.pages(ctx.orgId, ctx.siteId, ctx.versionId);
    return apiResponse(ctx, {
      partial_id: partialId,
      auto_injected: true,
      pages: pages.map((p) => ({ page_id: p.id, title: p.title, slug: p.slug, status: p.status })),
      templates: [],
      global_blocks: [],
    });
  }

  const usage = await getBlockUsage(ctx.orgId, ctx.siteId, ctx.versionId, partialId);
  return apiResponse(ctx, { partial_id: partialId, auto_injected: false, ...usage });
};
