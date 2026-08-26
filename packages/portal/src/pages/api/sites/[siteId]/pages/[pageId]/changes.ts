// GET — structured summary of the page's unsaved draft: which meta fields
// changed and a block-tree diff (added/removed/changed/moved). Powers the
// editor's "Review changes" overlay.

import type { APIRoute } from 'astro';
import { json, requireSiteAccess } from '../../../../../../lib/access';
import { pageChangeSummary } from '../../../../../../lib/change-summary';

export const GET: APIRoute = async ({ cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const { site, versionId, owner_org_id } = guard.value;
  if (!params.pageId) return json({ error: 'Missing pageId' }, 400);

  const summary = await pageChangeSummary(
    { orgId: owner_org_id, siteId: site.id, versionId },
    params.pageId,
  );
  if (!summary) return json({ error: 'Page not found' }, 404);
  return json(summary);
};
