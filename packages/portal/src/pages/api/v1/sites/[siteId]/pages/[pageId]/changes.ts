// GET — structured summary of a page's unsaved draft for agents: changed
// meta fields + a block-tree diff (added/removed/changed/moved). The MCP
// get_change_summary tool reads this so an agent can describe its own
// edits ("what will Save apply?") before asking a human to approve.

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../../lib/api-auth';
import { pageChangeSummary } from '../../../../../../../lib/change-summary';

export const GET: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  if (!params.pageId) return apiError('Missing pageId');

  const summary = await pageChangeSummary(
    { orgId: ctx.orgId, siteId: ctx.siteId, versionId: ctx.versionId },
    params.pageId,
  );
  if (!summary) return apiError('Page not found', 404);
  return apiResponse(ctx, summary);
};
