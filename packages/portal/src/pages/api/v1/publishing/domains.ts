import type { APIRoute } from 'astro';
import { requireAnyApiKey, apiResponse, apiError } from '../../../../lib/api-auth';
import { connectionFailure, publishingJsonBody } from '../../../../lib/publishing/http';
import { saveOrganizationDomains } from '../../../../lib/publishing/domain-config';

import { getOrganizationDomainStatus } from '../../../../lib/publishing/organization-domain-status';
import { setupOrganizationDomains } from '../../../../lib/publishing/organization-domain-setup';

async function handle(request: Request, write: boolean, setup = false) {
  const guard = await requireAnyApiKey(request);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  if (ctx.tokenSiteId !== null) return apiError('An organization API key is required to manage the organization default domain.', 403);
  try {
    if (write) await saveOrganizationDomains(ctx.tokenOrgId, await publishingJsonBody(request));
    const data = setup ? await setupOrganizationDomains(ctx.tokenOrgId, await publishingJsonBody(request)) : await getOrganizationDomainStatus(ctx.tokenOrgId);
    const response = apiResponse(ctx, data);
    response.headers.set('Cache-Control', 'no-store');
    return response;
  } catch (error) { return connectionFailure(error); }
}
export const GET: APIRoute = ({ request }) => handle(request, false);
export const PUT: APIRoute = ({ request }) => handle(request, true);
export const POST: APIRoute = ({ request }) => handle(request, false, true);
