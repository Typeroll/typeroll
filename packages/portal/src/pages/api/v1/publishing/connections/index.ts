// GET /api/v1/publishing/connections — the organization's GitHub and
// Cloudflare publishing connections: status, revision (needed to disconnect
// or change them), account identity, media readiness and media migration.
// No credentials are returned.
//
// OAuth sign-in to GitHub or Cloudflare needs a person in a browser.
// connect_urls point at the provider cards on the portal Publishing page,
// where an organization owner or admin completes it.
//
// Organization API key required. In the portal these connections are managed
// on the organization Publishing page by an organization owner or admin, and
// a site administrator has no access there, so a site-scoped key gets 403.
// The per-site publishing state lives under /api/v1/sites/{siteId}/publishing.

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireAnyApiKey } from '../../../../../lib/api-auth';
import { connectionFailure } from '../../../../../lib/publishing/http';
import { organizationConnectionsStatus, publishingConnectUrl } from '../../../../../lib/publishing/organization-connections';

export const GET: APIRoute = async ({ request }) => {
  const guard = await requireAnyApiKey(request);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  if (ctx.tokenSiteId !== null) {
    return apiError('An organization API key is required to read organization publishing connections. Site publishing status is at /api/v1/sites/{siteId}/publishing.', 403, ctx);
  }
  try {
    const response = apiResponse(ctx, {
      ...await organizationConnectionsStatus(ctx.tokenOrgId),
      connect_urls: { github: publishingConnectUrl('github'), cloudflare: publishingConnectUrl('cloudflare') },
    });
    response.headers.set('Cache-Control', 'no-store');
    return response;
  } catch (error) { return connectionFailure(error); }
};
