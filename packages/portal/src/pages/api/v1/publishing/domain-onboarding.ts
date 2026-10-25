import type { APIRoute } from 'astro';
import { requireAnyApiKey, apiError, apiResponse } from '../../../../lib/api-auth';
import { connectionFailure, publishingJsonBody } from '../../../../lib/publishing/http';
import { onboardDomainZone } from '../../../../lib/publishing/domain-zone-onboarding';
export const POST: APIRoute = async ({ request }) => {
  const guard = await requireAnyApiKey(request); if (!guard.ok) return guard.response;
  const ctx = guard.value;
  if (ctx.tokenSiteId !== null) return apiError('Organization administrator access is required for DNS zone onboarding.', 403);
  try {
    const input = await publishingJsonBody(request);
    if (typeof input.site_id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,127}$/.test(input.site_id)) return apiError('Select a site owned by this organization.', 400);
    return apiResponse(ctx, await onboardDomainZone(ctx.tokenOrgId, input.site_id, input));
  } catch (error) { return connectionFailure(error); }
};
