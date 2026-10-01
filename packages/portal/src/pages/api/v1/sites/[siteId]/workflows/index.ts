// GET  /api/v1/sites/{siteId}/workflows — available workflow types and the
//      site's most recent runs (?limit=, default 20, max 100).
// POST /api/v1/sites/{siteId}/workflows — start a workflow.
//      Body: { type, config? }. Returns { workflow_id } with 202; the run
//      continues in the background — poll GET .../workflows/{workflowId}.
//
// Same rules as the portal (/api/sites/{siteId}/workflows/start): starting
// needs write on the site, and rebuild_deploy, which publishes, needs admin
// like every other deploy route. Types: migration, site_planning, seo_audit,
// content_improvement, link_check, performance_audit, content_generation,
// schema_markup, url_parity, rebuild_deploy.

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../lib/api-auth';
import { connectionFailure } from '../../../../../../lib/publishing/http';
import { ConnectionError } from '../../../../../../lib/publishing/connections';
import {
  listSiteWorkflows, listWorkflowTypes, permissionCovers, resolveWorkflowType,
  startSiteWorkflow, workflowStartPermission, workflowSummary, WorkflowRequestError,
} from '../../../../../../lib/workflows/service';

export const GET: APIRoute = async ({ request, params, url }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const limit = Number(url.searchParams.get('limit') ?? 20);
  const runs = await listSiteWorkflows(ctx.orgId, ctx.siteId, Number.isFinite(limit) ? limit : 20);
  return apiResponse(ctx, { types: listWorkflowTypes(), workflows: runs.map(workflowSummary) });
};

export const POST: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;

  let body: { type?: unknown; config?: unknown };
  try { body = (await request.json()) as typeof body; } catch { return apiError('Invalid JSON body. Expected { type, config? }.', 400, ctx); }
  if (!body || typeof body !== 'object') return apiError('Invalid JSON body. Expected { type, config? }.', 400, ctx);
  try {
    const type = resolveWorkflowType(body.type);
    const required = workflowStartPermission(type);
    if (!permissionCovers(ctx.permission, required)) {
      return apiError(`Starting a ${type} workflow requires ${required} permission on the site.`, 403, ctx);
    }
    const { workflowId } = await startSiteWorkflow({
      orgId: ctx.orgId,
      siteId: ctx.siteId,
      type,
      config: body.config,
      versionId: ctx.versionId,
      createdBy: `api-key:${ctx.keyPrefix}`,
    });
    return apiResponse(ctx, { ok: true, workflow_id: workflowId, type, status: 'running' }, 202, { type });
  } catch (error) {
    if (error instanceof WorkflowRequestError) return apiError(error.message, error.status, ctx);
    if (error instanceof ConnectionError) return connectionFailure(error);
    throw error;
  }
};
