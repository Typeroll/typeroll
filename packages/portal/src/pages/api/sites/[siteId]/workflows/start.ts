// Start a workflow for a site.
//
// Body: { type: WorkflowType, config: Record<string, unknown> }
// The run is recorded and started in the background; the detail page polls.
// The public-API equivalent is POST /api/v1/sites/{siteId}/workflows; both
// use lib/workflows/service.

import { connectionFailure } from '../../../../../lib/publishing/http';
import { ConnectionError } from '../../../../../lib/publishing/connections';
import type { APIRoute } from 'astro';
import { requireSiteAccess, json, requirePermission } from '../../../../../lib/access';
import { resolveWorkflowType, startSiteWorkflow, workflowStartPermission, WorkflowRequestError } from '../../../../../lib/workflows/service';

export const POST: APIRoute = async ({ request, cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const writeCheck = requirePermission(guard.value, 'write');
  if (!writeCheck.ok) return writeCheck.response;
  const { session, site, owner_org_id, versionId } = guard.value;

  const body = (await request.json().catch(() => ({}))) as { type?: unknown; config?: unknown };
  try {
    const type = resolveWorkflowType(body.type);
    const permissionCheck = requirePermission(guard.value, workflowStartPermission(type));
    if (!permissionCheck.ok) return permissionCheck.response;
    const { workflowId } = await startSiteWorkflow({
      orgId: owner_org_id,
      siteId: site.id,
      type,
      config: body.config,
      versionId,
      createdBy: session.userId,
    });
    return json({ ok: true, workflowId });
  } catch (error) {
    if (error instanceof WorkflowRequestError) return json({ error: error.message }, error.status);
    if (error instanceof ConnectionError) return connectionFailure(error);
    throw error;
  }
};
