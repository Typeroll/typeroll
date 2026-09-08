import type { APIRoute } from 'astro';
import { requireAnyApiKey, apiResponse, apiError } from '../../../../lib/api-auth';
import { connectionFailure } from '../../../../lib/publishing/http';
import { listOrganizationPublishingZones } from '../../../../lib/publishing/organization-domain-setup';

export const GET: APIRoute = async ({ request }) => {
  const guard = await requireAnyApiKey(request);
  if (!guard.ok) return guard.response;
  if (guard.value.tokenSiteId !== null) return apiError('An organization API key is required to list publishing domains.', 403);
  try {
    const response = apiResponse(guard.value, await listOrganizationPublishingZones(guard.value.tokenOrgId));
    response.headers.set('Cache-Control', 'no-store');
    return response;
  } catch (error) { return connectionFailure(error); }
};
