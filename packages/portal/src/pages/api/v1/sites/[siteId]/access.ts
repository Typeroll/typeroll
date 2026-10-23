import type { APIRoute } from 'astro';
import { requireApiKey, apiResponse } from '../../../../../lib/api-auth';
import { readOrganizationAccess } from '../../../../../lib/organization-access';
export const GET: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  return apiResponse(guard.value, { access: await readOrganizationAccess(guard.value.orgId) });
};
