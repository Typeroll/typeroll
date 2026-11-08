// POST /api/v1/sites/{siteId}/clipboard/copy — copy blocks of a page's draft.
//      JSON: { page_id, block_ids: [id, …] }
//      → { clipboard, clipboard_text, clipboard_html, count: { top, total }, warnings }
// Writes nothing, so it counts as a read. Same as the portal route.

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../lib/api-auth';
import { copyBlocks, parseCopyRequest, portalOrigin } from '../../../../../../lib/packages/clipboard';
import { packageApiFailure } from '../../../../../../lib/packages/package-api';

export const POST: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId, { sideEffectFree: true });
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  if (ctx.extensionIdentity) return apiError('Extension credentials cannot copy blocks', 403, ctx);
  const body = await request.json().catch(() => null);
  try {
    const result = await copyBlocks({ orgId: ctx.orgId, siteId: ctx.siteId, versionId: ctx.versionId, portal: portalOrigin(request) }, parseCopyRequest(body));
    return apiResponse(ctx, result);
  } catch (error) { return packageApiFailure(error, ctx); }
};
