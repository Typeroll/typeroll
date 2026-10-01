// Approve a paused workflow → resumes from the step after the review gate.
// The public-API equivalent is
// POST /api/v1/sites/{siteId}/workflows/{workflowId}/approve.

import { connectionFailure } from '../../../../../../lib/publishing/http';
import { ConnectionError } from '../../../../../../lib/publishing/connections';
import type { APIRoute } from 'astro';
import { requireSiteAccess, json, requirePermission } from '../../../../../../lib/access';
import { approveSiteWorkflow, WorkflowRequestError } from '../../../../../../lib/workflows/service';

export const POST: APIRoute = async ({ cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const writeCheck = requirePermission(guard.value, 'write');
  if (!writeCheck.ok) return writeCheck.response;
  const { site, owner_org_id } = guard.value;
  if (!params.workflowId) return json({ error: 'Missing workflowId' }, 400);

  try {
    await approveSiteWorkflow(owner_org_id, site.id, params.workflowId);
    return json({ ok: true });
  } catch (error) {
    if (error instanceof WorkflowRequestError) return json({ error: error.message }, error.status);
    if (error instanceof ConnectionError) return connectionFailure(error);
    throw error;
  }
};
