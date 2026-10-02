// GET /api/sites/{siteId}/blocks/types/usage?id=…
//
// Where a block type is used: pages (saved or in a draft), page templates,
// headers, footers and global blocks, block templates, and other site block
// types built from it (`via` names the composed type a use goes through).
// The builder's Usage tab reads this; deletion refuses while any use remains.

import type { APIRoute } from 'astro';
import { json, requireSiteAccess } from '../../../../../../lib/access';
import { getBlockTypeUsage, usageCount } from '../../../../../../lib/block-type-usage';

export const GET: APIRoute = async ({ request, cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const { site, versionId, owner_org_id } = guard.value;
  const id = new URL(request.url).searchParams.get('id');
  if (!id) return json({ error: 'id query param required' }, 400);
  const usage = await getBlockTypeUsage(owner_org_id, site.id, versionId, id);
  return json({ type_id: id, total: usageCount(usage), ...usage });
};
