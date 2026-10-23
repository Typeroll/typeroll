import type { APIRoute } from 'astro';
import { requireAnyApiKey, apiResponse, apiError } from '../../../lib/api-auth';
import { readOrganizationAccess } from '../../../lib/organization-access';
export const GET: APIRoute = async ({ request }) => {
  const guard = await requireAnyApiKey(request);
  if (!guard.ok) return guard.response;
  if (!guard.value.orgId) return apiError('Select an organization using Typeroll-Organization.', 400);
  return apiResponse(guard.value, { access: await readOrganizationAccess(guard.value.orgId) });
};
