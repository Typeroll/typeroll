// GET  /api/v1/sites/{siteId}/api-keys — list the site's API keys (metadata only).
// POST /api/v1/sites/{siteId}/api-keys — create a site-scoped key; the token is
//                                        returned once and never again.
//
// Same rules as the settings UI (/api/sites/{siteId}/api-keys): any caller that
// reaches the site may list, creating needs admin on the site. A site-scoped
// key reaches only its own site, so it can mint keys for that site and no
// other. The new key is bound to the same single site, so no caller can mint
// a key that reaches further than it already does.

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../lib/api-auth';
import { apiKeySummary, createApiKey, createdApiKeyResponse, listApiKeys, parseApiKeyName } from '../../../../../../lib/api-keys';

export const GET: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const keys = await listApiKeys(ctx.orgId, ctx.siteId);
  return apiResponse(ctx, { keys: keys.map(apiKeySummary) });
};

export const POST: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  if (ctx.permission !== 'admin') return apiError('Managing API keys requires admin permission on the site.', 403, ctx);

  let body: unknown;
  try { body = await request.json(); } catch { return apiError('Invalid JSON body. Expected { name }.', 400, ctx); }
  const parsed = parseApiKeyName(body);
  if ('error' in parsed) return apiError(parsed.error, 400, ctx);

  const result = await createApiKey({
    orgId: ctx.orgId,
    siteId: ctx.siteId,
    name: parsed.name,
    createdBy: `api-key:${ctx.keyPrefix}`,
  });
  const response = apiResponse(ctx, createdApiKeyResponse(result), 201, { name: parsed.name });
  response.headers.set('Cache-Control', 'no-store');
  return response;
};
