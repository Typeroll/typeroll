// GET /api/v1/sites/{siteId}/workflows/{workflowId} — status, progress, log,
// review gate and results of one workflow run. Internal step state is omitted
// and credential-bearing config is masked, exactly as in the portal.

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../../lib/api-auth';
import { readSiteWorkflow, workflowSummary } from '../../../../../../../lib/workflows/service';

export const GET: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const wf = await readSiteWorkflow(ctx.orgId, ctx.siteId, params.workflowId);
  if (!wf) return apiError('Workflow not found', 404, ctx);
  return apiResponse(ctx, { workflow: workflowSummary(wf) });
};
