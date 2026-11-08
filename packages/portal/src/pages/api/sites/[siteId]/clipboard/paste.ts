// POST /api/sites/{siteId}/clipboard/paste — paste copied blocks into a page's draft.
//      JSON: { clipboard, page_id, after_block_id? | position?, parent_id?, slot_index? }
//      → { report, page: { id, added_ids, blocks }, mode, media, message }
//
// clipboard is the copied text (clipboard_text) or its object. The blocks get
// new ids and go after after_block_id (in that block's parent or slot when it
// is nested), or at position (top level, or in parent_id / slot_index); at
// the end by default. From another site, the styles the blocks use are
// created here, never mapped to "nearest" ones (a differing one becomes e.g.
// hero-2, "Hero (imported)"), block types and global blocks likewise, and
// each media file is copied into this site's Media library when this session
// may read the site it came from; one it cannot read is left out with a
// warning. Needs write permission.

import type { APIRoute } from 'astro';
import { json, requirePermission, requireSiteAccess } from '../../../../../lib/access';
import { parsePasteRequest, pasteBlocks, portalOrigin } from '../../../../../lib/packages/clipboard';
import { sessionSourceAccess } from '../../../../../lib/packages/clipboard-routes';
import { packageFailureBody } from '../../../../../lib/packages/package-requests';

export const POST: APIRoute = async ({ request, cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const write = requirePermission(guard.value, 'write');
  if (!write.ok) return write.response;
  const { session, site, versionId, owner_org_id, permission, design } = guard.value;
  const body = await request.json().catch(() => null);
  try {
    const result = await pasteBlocks(
      { orgId: owner_org_id, siteId: site.id, versionId, permission, design, actor: session.email || session.userId, portal: portalOrigin(request) },
      parsePasteRequest(body),
      { sourceAccess: sessionSourceAccess(cookies) },
    );
    return json(result);
  } catch (error) {
    const refused = packageFailureBody(error);
    if (!refused) throw error;
    return json(refused.body, refused.status);
  }
};
