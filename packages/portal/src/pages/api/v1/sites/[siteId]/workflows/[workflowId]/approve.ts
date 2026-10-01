// POST /api/v1/sites/{siteId}/workflows/{workflowId}/approve — approve the
// review gate of a run that is paused_for_review; it resumes in the
// background from the next step. Write permission on the site, as in the
// portal. A run in any other status returns 409.

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../../lib/api-auth';
import { connectionFailure } from '../../../../../../../lib/publishing/http';
import { ConnectionError } from '../../../../../../../lib/publishing/connections';
import { approveSiteWorkflow, WorkflowRequestError } from '../../../../../../../lib/workflows/service';

export const POST: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  try {
    const wf = await approveSiteWorkflow(ctx.orgId, ctx.siteId, params.workflowId);
    return apiResponse(ctx, { ok: true, workflow_id: wf.id, status: 'running' }, 202);
  } catch (error) {
    if (error instanceof WorkflowRequestError) return apiError(error.status === 404 ? 'Workflow not found' : error.message, error.status, ctx);
    if (error instanceof ConnectionError) return connectionFailure(error);
    throw error;
  }
};
