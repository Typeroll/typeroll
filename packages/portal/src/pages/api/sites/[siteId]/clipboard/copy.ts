// POST /api/sites/{siteId}/clipboard/copy — copy blocks of a page's draft.
//      JSON: { page_id, block_ids: [id, …] }
//      → { clipboard, clipboard_text, clipboard_html, count: { top, total }, warnings }
//
// The clipboard holds the blocks (in page order; a block inside another
// copied block comes with it) and the styles, site block types and free
// global blocks they use; media keep their addresses. Put clipboard_text on
// the system clipboard (text/plain) and paste it with
// POST /api/sites/{siteId}/clipboard/paste on any site. Needs read access.

import type { APIRoute } from 'astro';
import { json, requireSiteAccess } from '../../../../../lib/access';
import { copyBlocks, parseCopyRequest, portalOrigin } from '../../../../../lib/packages/clipboard';
import { packageFailureBody } from '../../../../../lib/packages/package-requests';

export const POST: APIRoute = async ({ request, cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const { site, versionId, owner_org_id } = guard.value;
  const body = await request.json().catch(() => null);
  try {
    const result = await copyBlocks({ orgId: owner_org_id, siteId: site.id, versionId, portal: portalOrigin(request) }, parseCopyRequest(body));
    return json(result);
  } catch (error) {
    const refused = packageFailureBody(error);
    if (!refused) throw error;
    return json(refused.body, refused.status);
  }
};
