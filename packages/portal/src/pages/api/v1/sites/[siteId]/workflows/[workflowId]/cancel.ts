// POST /api/v1/sites/{siteId}/workflows/{workflowId}/cancel — cancel a run
// that is pending, running or paused for review; it is recorded as
// `cancelled`. Cancelling needs the permission that starting the type needs
// (write; admin for rebuild_deploy). A finished run returns 409.

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../../lib/api-auth';
import { cancelSiteWorkflow, workflowSummary, WorkflowRequestError } from '../../../../../../../lib/workflows/service';

export const POST: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  try {
    const wf = await cancelSiteWorkflow({
      orgId: ctx.orgId,
      siteId: ctx.siteId,
      workflowId: params.workflowId,
      permission: ctx.permission,
      cancelledBy: `api-key:${ctx.keyPrefix}`,
    });
    return apiResponse(ctx, { ok: true, workflow: workflowSummary(wf) });
  } catch (error) {
    if (error instanceof WorkflowRequestError) return apiError(error.status === 404 ? 'Workflow not found' : error.message, error.status, ctx);
    throw error;
  }
};
