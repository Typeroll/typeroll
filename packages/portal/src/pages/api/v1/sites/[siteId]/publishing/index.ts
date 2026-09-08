import type { APIRoute } from 'astro';
import { requireApiKey, apiResponse } from '../../../../../../lib/api-auth';
import { publishingReadiness } from '../../../../../../lib/publishing/readiness';

export const GET: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  return apiResponse(guard.value, await publishingReadiness(guard.value.orgId, guard.value.siteId, guard.value.versionId));
};
