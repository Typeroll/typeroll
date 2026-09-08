import type { APIRoute } from 'astro';
import { requireApiKey, apiResponse } from '../../../../../../lib/api-auth';
import { customerBuildStatus } from '../../../../../../lib/publishing/build-status';
import { connectionFailure } from '../../../../../../lib/publishing/http';

export const GET: APIRoute = async ({ request, params, url }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  try { return apiResponse(guard.value, await customerBuildStatus(guard.value.orgId, guard.value.siteId, url.searchParams.get('job_id') ?? '')); }
  catch (error) { return connectionFailure(error); }
};
