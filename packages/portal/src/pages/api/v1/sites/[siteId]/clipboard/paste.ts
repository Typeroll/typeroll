// POST /api/v1/sites/{siteId}/clipboard/paste — paste copied blocks into a page's draft.
//      JSON: { clipboard, page_id, after_block_id? | position?, parent_id?, slot_index? }
//      → { report, page: { id, added_ids, blocks }, mode, media, message }
//
// Same as the portal route. Media of another site is copied only when this
// key may read that site: an organization key reaches the organization's
// sites (and those shared with it), a site key only its own site, so a site
// key pastes another site's blocks without their private media. Needs write
// permission; not for app installations.

import type { APIRoute } from 'astro';
import { apiCanDesign, apiError, apiResponse, requireApiKey } from '../../../../../../lib/api-auth';
import { parsePasteRequest, pasteBlocks, portalOrigin } from '../../../../../../lib/packages/clipboard';
import { apiSourceAccess, pasteAuditBody } from '../../../../../../lib/packages/clipboard-routes';
import { packageApiFailure } from '../../../../../../lib/packages/package-api';
import { apiUpdatedBy } from '../../../../../../lib/snippet-write';

export const POST: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  if (ctx.extensionIdentity) return apiError('Extension credentials cannot paste blocks', 403, ctx);
  if (ctx.permission === 'read') return apiError('Insufficient permission (write required)', 403, ctx);
  const body = await request.json().catch(() => null);
  try {
    const result = await pasteBlocks(
      { orgId: ctx.orgId, siteId: ctx.siteId, versionId: ctx.versionId, permission: ctx.permission, design: apiCanDesign(ctx), actor: apiUpdatedBy(ctx.keyPrefix), portal: portalOrigin(request) },
      parsePasteRequest(body),
      { sourceAccess: apiSourceAccess(ctx) },
    );
    return apiResponse(ctx, result, 200, pasteAuditBody(body));
  } catch (error) { return packageApiFailure(error, ctx); }
};
