// GET  /api/v1/organization/api-keys — list the organization's org-scoped keys.
// POST /api/v1/organization/api-keys — create an org-scoped key; the token is
//                                      returned once and never again.
//
// Organization API keys only. A site-scoped key is bound to one site and must
// never mint a key that reaches the whole organization. An organization key
// already acts for the organization with admin on its sites, which is exactly
// what a new organization key carries, so it cannot widen its own reach.
// Site-scoped keys for one site are created under /api/v1/sites/{siteId}/api-keys.

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireAnyApiKey } from '../../../../../lib/api-auth';
import { apiKeySummary, createApiKey, createdApiKeyResponse, listApiKeys, parseApiKeyName } from '../../../../../lib/api-keys';

const ORG_KEY_REQUIRED = 'An organization API key is required to manage organization API keys. This key is bound to a single site.';

export const GET: APIRoute = async ({ request }) => {
  const guard = await requireAnyApiKey(request);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  if (ctx.tokenSiteId !== null) return apiError(ORG_KEY_REQUIRED, 403, ctx);
  const keys = await listApiKeys(ctx.tokenOrgId, null);
  return apiResponse(ctx, { keys: keys.map(apiKeySummary) });
};

export const POST: APIRoute = async ({ request }) => {
  const guard = await requireAnyApiKey(request);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  if (ctx.tokenSiteId !== null) return apiError(ORG_KEY_REQUIRED, 403, ctx);

  let body: unknown;
  try { body = await request.json(); } catch { return apiError('Invalid JSON body. Expected { name }.', 400, ctx); }
  const parsed = parseApiKeyName(body);
  if ('error' in parsed) return apiError(parsed.error, 400, ctx);

  const result = await createApiKey({
    orgId: ctx.tokenOrgId,
    siteId: null,
    name: parsed.name,
    createdBy: `api-key:${ctx.keyPrefix}`,
  });
  const response = apiResponse(ctx, createdApiKeyResponse(result), 201, { name: parsed.name });
  response.headers.set('Cache-Control', 'no-store');
  return response;
};
