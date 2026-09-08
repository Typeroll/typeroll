import type { APIRoute } from 'astro';
import { requireApiKey, apiResponse, apiError } from '../../../../../../lib/api-auth';
import { connectionFailure, publishingJsonBody } from '../../../../../../lib/publishing/http';
import { getSiteDomains, saveSiteDomains } from '../../../../../../lib/publishing/domain-config';

export const GET: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  try { return apiResponse(guard.value, await getSiteDomains(guard.value.orgId, guard.value.siteId)); }
  catch (error) { return connectionFailure(error); }
};

export const PUT: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  if (guard.value.permission !== 'admin') return apiError('Domain management requires admin permission on the site.', 403);
  try { return apiResponse(guard.value, await saveSiteDomains(guard.value.orgId, guard.value.siteId, await publishingJsonBody(request))); }
  catch (error) { return connectionFailure(error); }
};
