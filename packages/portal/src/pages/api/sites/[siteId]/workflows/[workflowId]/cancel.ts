// Cancel a pending, running or paused workflow run (the detail page's Cancel
// button). The public-API equivalent is
// POST /api/v1/sites/{siteId}/workflows/{workflowId}/cancel.

import type { APIRoute } from 'astro';
import { requireSiteAccess, json, requirePermission } from '../../../../../../lib/access';
import { cancelSiteWorkflow, workflowSummary, WorkflowRequestError } from '../../../../../../lib/workflows/service';

export const POST: APIRoute = async ({ cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const writeCheck = requirePermission(guard.value, 'write');
  if (!writeCheck.ok) return writeCheck.response;
  const { session, site, owner_org_id, permission } = guard.value;
  if (!params.workflowId) return json({ error: 'Missing workflowId' }, 400);

  try {
    const wf = await cancelSiteWorkflow({
      orgId: owner_org_id,
      siteId: site.id,
      workflowId: params.workflowId,
      permission,
      cancelledBy: session.userId,
    });
    return json(workflowSummary(wf));
  } catch (error) {
    if (error instanceof WorkflowRequestError) return json({ error: error.message }, error.status);
    throw error;
  }
};
