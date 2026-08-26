// Start a workflow for a site.
//
// Body: { type: WorkflowType, config: Record<string, unknown> }
// We kick off the workflow immediately and run it inline; for long-running
// workflows (migration), the response comes back as soon as the first
// review gate is hit or the workflow finishes.

import type { APIRoute } from 'astro';
import { requireSiteAccess, json, requirePermission } from '../../../../../lib/access';
import { WorkflowEngine } from '../../../../../lib/workflows/engine';
import { getWorkflowDef } from '../../../../../lib/workflows/registry';
import type { WorkflowType } from '@typeroll/shared';

export const POST: APIRoute = async ({ request, cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const writeCheck = requirePermission(guard.value, 'write');
  if (!writeCheck.ok) return writeCheck.response;
  const { session, site, owner_org_id } = guard.value;

  const body = (await request.json().catch(() => ({}))) as {
    type?: WorkflowType;
    config?: Record<string, unknown>;
  };
  if (!body.type) return json({ error: 'Missing type' }, 400);

  let def;
  try {
    def = getWorkflowDef(body.type);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'Unknown workflow' }, 400);
  }

  const engine = new WorkflowEngine();
  const workflowId = await engine.create({
    orgId: owner_org_id,
    siteId: site.id,
    def,
    config: body.config ?? {},
    triggeredBy: 'manual',
    createdBy: session.userId,
  });

  // Run in background — we don't await. The detail page polls.
  engine.start(owner_org_id, workflowId, def).catch((err) => {
    console.error(`[workflow ${workflowId}] failed:`, err);
  });

  return json({ ok: true, workflowId });
};
