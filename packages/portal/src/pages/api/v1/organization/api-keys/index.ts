// GET  /api/v1/organization/api-keys — list the organization's org-scoped keys.
// POST /api/v1/organization/api-keys — refused: keys are created in the portal.
//
// Organization API keys only; revoke with DELETE …/organization/api-keys/{prefix}.

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireAnyApiKey } from '../../../../../lib/api-auth';
import { CREATE_KEY_IN_PORTAL, apiKeySummary, listApiKeys } from '../../../../../lib/api-keys';

const ORG_KEY_REQUIRED = 'An organization API key is required to manage organization API keys. This key is bound to a single site.';

export const GET: APIRoute = async ({ request }) => {
  const guard = await requireAnyApiKey(request);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  if (ctx.tokenSiteId !== null) return apiError(ORG_KEY_REQUIRED, 403, ctx);
  const keys = await listApiKeys(ctx.tokenOrgId, null);
  return apiResponse(ctx, { keys: keys.map(apiKeySummary) });
};

// New secrets are shown only in the portal, so they never land in an agent's
// conversation or a tool log. Listing and revoking stay available here.
export const POST: APIRoute = async ({ request }) => {
  const guard = await requireAnyApiKey(request);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  return apiError(CREATE_KEY_IN_PORTAL, 403, ctx);
};
