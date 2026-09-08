import type { APIRoute } from 'astro';
import { requireAnyApiKey, apiResponse, apiError } from '../../../../lib/api-auth';
import { connectionFailure, publishingJsonBody } from '../../../../lib/publishing/http';
import { getOrganizationDomains, saveOrganizationDomains } from '../../../../lib/publishing/domain-config';

async function handle(request: Request, write: boolean) {
  const guard = await requireAnyApiKey(request);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  if (ctx.tokenSiteId !== null) return apiError('An organization API key is required to manage the organization default domain.', 403);
  try {
    const data = write ? await saveOrganizationDomains(ctx.tokenOrgId, await publishingJsonBody(request)) : await getOrganizationDomains(ctx.tokenOrgId);
    return apiResponse(ctx, data);
  } catch (error) { return connectionFailure(error); }
}
export const GET: APIRoute = ({ request }) => handle(request, false);
export const PUT: APIRoute = ({ request }) => handle(request, true);
