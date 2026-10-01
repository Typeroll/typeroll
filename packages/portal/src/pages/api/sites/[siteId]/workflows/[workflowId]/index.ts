// Get workflow status (used by the UI for polling). Returns the same
// projection as GET /api/v1/sites/{siteId}/workflows/{workflowId}: internal
// step state is omitted and credential-bearing config is masked.

import type { APIRoute } from 'astro';
import { requireSiteAccess, json } from '../../../../../../lib/access';
import { readSiteWorkflow, workflowSummary } from '../../../../../../lib/workflows/service';

export const GET: APIRoute = async ({ cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const { site, owner_org_id } = guard.value;
  if (!params.workflowId) return json({ error: 'Missing workflowId' }, 400);

  const wf = await readSiteWorkflow(owner_org_id, site.id, params.workflowId);
  if (!wf) return json({ error: 'Not found' }, 404);
  return json(workflowSummary(wf));
};
