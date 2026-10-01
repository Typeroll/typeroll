// GET  /api/v1/sites/{siteId}/api-keys — list the site's API keys (metadata only).
// POST /api/v1/sites/{siteId}/api-keys — refused: keys are created in the portal.
//
// Any caller that reaches the site may list, as in the settings UI. Revoke
// with DELETE /api/v1/sites/{siteId}/api-keys/{prefix}.

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../lib/api-auth';
import { CREATE_KEY_IN_PORTAL, apiKeySummary, listApiKeys } from '../../../../../../lib/api-keys';

export const GET: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const keys = await listApiKeys(ctx.orgId, ctx.siteId);
  return apiResponse(ctx, { keys: keys.map(apiKeySummary) });
};

// New secrets are shown only in the portal, so they never land in an agent's
// conversation or a tool log. Listing and revoking stay available here.
export const POST: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  return apiError(CREATE_KEY_IN_PORTAL, 403, ctx);
};
