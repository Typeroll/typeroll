// Poll endpoint for a deploy job. The client hits this every couple of
// seconds while the job is in 'queued' or 'running' state.

import type { APIRoute } from 'astro';
import { requireSiteAccess, json } from '../../../../../lib/access';
import { getStore } from '../../../../../lib/datastore';
import { paths } from '@typeroll/shared';
import type { DeployJob } from '@typeroll/shared';

export const GET: APIRoute = async ({ cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const { session, site, owner_org_id } = guard.value;
  const { deployId } = params;
  if (!deployId) return json({ error: 'Missing deployId' }, 400);

  const job = await getStore().getDoc<DeployJob>(paths.deploy(owner_org_id, site.id, deployId));
  if (!job) return json({ error: 'Not found' }, 404);
  return json(job);
};
