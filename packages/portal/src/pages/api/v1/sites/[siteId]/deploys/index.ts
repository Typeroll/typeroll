// GET /api/v1/sites/{siteId}/deploys
//
// Lists recent deploy jobs, newest first. Capped at 50 so a chatty
// integration can't pull a massive history.

import type { APIRoute } from 'astro';
import { apiResponse, requireApiKey } from '../../../../../../lib/api-auth';
import { getStore } from '../../../../../../lib/datastore';
import { paths } from '@typeroll/shared';
import type { DeployJob } from '@typeroll/shared';

export const GET: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const all = await getStore().listDocs<DeployJob>(paths.deploys(ctx.orgId, ctx.siteId));
  const jobs = all
    .sort((a, b) => (b.started_at ?? '').localeCompare(a.started_at ?? ''))
    .slice(0, 50);
  return apiResponse(ctx, { jobs });
};
