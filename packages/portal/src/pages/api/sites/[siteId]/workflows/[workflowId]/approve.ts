// Approve a paused workflow → resumes from the step after the review gate.

import { requireImportStorage } from '../../../../../../lib/media/import-policy';
import { connectionFailure } from '../../../../../../lib/publishing/http';
import type { APIRoute } from 'astro';
import { requireSiteAccess, json, requirePermission } from '../../../../../../lib/access';
import { WorkflowEngine } from '../../../../../../lib/workflows/engine';
import { getWorkflowDef } from '../../../../../../lib/workflows/registry';
import { getStore } from '../../../../../../lib/datastore';
import { paths } from '@typeroll/shared';
import type { WorkflowRecord } from '../../../../../../lib/workflows/types';

export const POST: APIRoute = async ({ cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const writeCheck = requirePermission(guard.value, 'write');
  if (!writeCheck.ok) return writeCheck.response;
  const { session, site, owner_org_id } = guard.value;
  const { workflowId } = params;
  if (!workflowId) return json({ error: 'Missing workflowId' }, 400);

  const store = getStore();
  const wf = await store.getDoc<WorkflowRecord>(`${paths.workflows(owner_org_id)}/${workflowId}`);
  if (!wf || wf.site_id !== site.id) return json({ error: 'Not found' }, 404);

  const def = getWorkflowDef(wf.type);
  try { if (def.type === 'migration') await requireImportStorage(owner_org_id); }
  catch (error) { return connectionFailure(error); }
  const engine = new WorkflowEngine();
  engine.resume(owner_org_id, workflowId, def).catch((err) => {
    console.error(`[workflow ${workflowId}] resume failed:`, err);
  });

  return json({ ok: true });
};
