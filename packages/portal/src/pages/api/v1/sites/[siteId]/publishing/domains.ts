import type { APIRoute } from 'astro';
import { requireApiKey, apiResponse, apiError } from '../../../../../../lib/api-auth';
import { connectionFailure, publishingJsonBody } from '../../../../../../lib/publishing/http';
import { getSiteDomains, saveSiteDomains } from '../../../../../../lib/publishing/domain-config';
import { siteDomainsWithChecks } from '../../../../../../lib/publishing/host-checks';

export const GET: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const { orgId, siteId } = guard.value;
  try { return apiResponse(guard.value, await siteDomainsWithChecks(orgId, siteId, await getSiteDomains(orgId, siteId), guard.value.versionId)); }
  catch (error) { return connectionFailure(error); }
};

export const PUT: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  if (guard.value.permission !== 'admin') return apiError('Domain management requires admin permission on the site.', 403);
  const { orgId, siteId } = guard.value;
  try { return apiResponse(guard.value, await siteDomainsWithChecks(orgId, siteId, await saveSiteDomains(orgId, siteId, await publishingJsonBody(request)), guard.value.versionId)); }
  catch (error) { return connectionFailure(error); }
};
