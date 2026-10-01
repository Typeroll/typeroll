// DELETE /api/v1/organization/api-keys/{prefix} — revoke an org-scoped key.
// Organization API keys only, as for listing and creating. Site-scoped keys
// are revoked under /api/v1/sites/{siteId}/api-keys/{prefix}.

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireAnyApiKey } from '../../../../../lib/api-auth';
import { isApiKeyPrefix, revokeApiKey } from '../../../../../lib/api-keys';

export const DELETE: APIRoute = async ({ request, params }) => {
  const guard = await requireAnyApiKey(request);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  if (ctx.tokenSiteId !== null) {
    return apiError('An organization API key is required to manage organization API keys. This key is bound to a single site.', 403, ctx);
  }
  if (!isApiKeyPrefix(params.prefix)) return apiError('API key not found', 404, ctx);
  const revoked = await revokeApiKey(ctx.tokenOrgId, null, params.prefix);
  if (!revoked) return apiError('API key not found', 404, ctx);
  return apiResponse(ctx, { ok: true, id: params.prefix });
};
