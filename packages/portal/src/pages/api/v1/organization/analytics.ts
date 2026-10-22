// GET  /api/v1/organization/analytics — every active Site of the Organization
//      with Analytics on or off and its setup (ready, or the cause and next
//      step), plus each Hosting Group's Cloudflare permissions.
// POST /api/v1/organization/analytics — { sites: [{ site_id, enabled }] }
//      turns Analytics on or off for the listed Sites only (at most 50), each
//      through the same path as update_app, and returns one result per Site.
//
// Approving Cloudflare permissions enables Analytics for no Site; this is
// where an owner, admin or agent chooses the Sites. Organization API key
// required (a site-scoped key gets 403), matching the owner/admin rule of the
// portal overview. Beacon tokens and credentials are not returned.

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireAnyApiKey } from '../../../../lib/api-auth';
import { analyticsChanges, readAnalyticsOverview, setOrganizationAnalytics } from '../../../../lib/apps/analytics-overview';
import { connectionFailure, publishingJsonBody } from '../../../../lib/publishing/http';

async function guarded(request: Request) {
  const guard = await requireAnyApiKey(request);
  if (!guard.ok) return guard;
  if (guard.value.tokenSiteId !== null) {
    return { ok: false as const, response: apiError('An organization API key is required to manage Analytics across Sites. Use update_app for one Site.', 403, guard.value) };
  }
  return guard;
}

export const GET: APIRoute = async ({ request }) => {
  const guard = await guarded(request);
  if (!guard.ok) return guard.response;
  try {
    const response = apiResponse(guard.value, await readAnalyticsOverview(guard.value.tokenOrgId));
    response.headers.set('Cache-Control', 'no-store');
    return response;
  } catch (error) { return connectionFailure(error); }
};

export const POST: APIRoute = async ({ request }) => {
  const guard = await guarded(request);
  if (!guard.ok) return guard.response;
  try {
    const changes = analyticsChanges(await publishingJsonBody(request, 64 * 1024));
    const results = await setOrganizationAnalytics(guard.value.tokenOrgId, changes);
    const response = apiResponse(guard.value, { results });
    response.headers.set('Cache-Control', 'no-store');
    return response;
  } catch (error) { return connectionFailure(error); }
};
export const PUT = POST;
