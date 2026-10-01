// POST   /api/v1/publishing/connections/cloudflare — browserless Cloudflare steps
//        for the organization's default connection:
//        { action: 'connect', revision, account_id, bucket, api_token, access_key_id, secret_access_key }
//        { action: 'prepare_media', revision }
//        { action: 'save_media', revision, access_key_id, secret_access_key }
// DELETE /api/v1/publishing/connections/{github|cloudflare}
//        { revision, hosting_group_id? } — disconnect at the revision read from
//        GET /api/v1/publishing/connections. Stored credentials are erased;
//        existing sites, media and DNS are not changed.
//
// Organization API key required, matching the organization owner/admin rule
// of the portal Publishing page. GitHub sign-in and App installation, and
// Cloudflare OAuth sign-in, need a browser: use connect_urls from the status.

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireAnyApiKey, type ApiContext } from '../../../../../lib/api-auth';
import type { FullSession } from '../../../../../lib/access';
import { connectionFailure, publishingJsonBody } from '../../../../../lib/publishing/http';
import {
  applyCloudflareConnectionAction, disconnectOrganizationProvider, isPublishingProvider, publishingConnectUrl,
} from '../../../../../lib/publishing/organization-connections';

async function organizationKey(request: Request) {
  const guard = await requireAnyApiKey(request);
  if (!guard.ok) return guard;
  if (guard.value.tokenSiteId !== null) {
    return { ok: false as const, response: apiError('An organization API key is required to manage organization publishing connections.', 403, guard.value) };
  }
  return guard;
}

function respond(ctx: ApiContext, data: unknown, audit?: unknown) {
  const response = apiResponse(ctx, data, 200, audit);
  response.headers.set('Cache-Control', 'no-store');
  return response;
}

export const POST: APIRoute = async ({ request, params }) => {
  const guard = await organizationKey(request);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  if (!isPublishingProvider(params.provider)) return apiError('Unknown publishing provider', 404, ctx);
  if (params.provider === 'github') {
    return apiError(`GitHub is connected by an organization owner or admin in a browser: ${publishingConnectUrl('github')}`, 409, ctx);
  }
  try {
    const body = await publishingJsonBody(request);
    // The credential-handling functions record who connected; an API key is
    // recorded by its prefix, as elsewhere in the audit trail.
    const actor = { orgId: ctx.tokenOrgId, userId: `api-key:${ctx.keyPrefix}`, email: '' } satisfies FullSession;
    const result = await applyCloudflareConnectionAction(actor, body);
    // Never echo or audit credentials.
    return respond(ctx, result, { action: body.action });
  } catch (error) { return connectionFailure(error); }
};

export const DELETE: APIRoute = async ({ request, params }) => {
  const guard = await organizationKey(request);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  if (!isPublishingProvider(params.provider)) return apiError('Unknown publishing provider', 404, ctx);
  try {
    const body = await publishingJsonBody(request);
    return respond(ctx, await disconnectOrganizationProvider(ctx.tokenOrgId, params.provider, body),
      { revision: body.revision, hosting_group_id: body.hosting_group_id });
  } catch (error) { return connectionFailure(error); }
};
