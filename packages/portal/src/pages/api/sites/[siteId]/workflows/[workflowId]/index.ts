// Get workflow status (used by the UI for polling).

import type { APIRoute } from 'astro';
import { requireSiteAccess, json } from '../../../../../../lib/access';
import { getStore } from '../../../../../../lib/datastore';
import { paths } from '@typeroll/shared';
import type { WorkflowRecord } from '../../../../../../lib/workflows/types';

export const GET: APIRoute = async ({ cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const { session, site, owner_org_id } = guard.value;
  const { workflowId } = params;
  if (!workflowId) return json({ error: 'Missing workflowId' }, 400);

  const wf = await getStore().getDoc<WorkflowRecord>(`${paths.workflows(owner_org_id)}/${workflowId}`);
  if (!wf || wf.site_id !== site.id) return json({ error: 'Not found' }, 404);
  return json(wf);
};
