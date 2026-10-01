// DELETE /api/v1/sites/{siteId}/api-keys/{prefix} — revoke one of the site's
// keys. Marks it revoked (kept for audit history) and stops it authenticating
// immediately. Admin on the site, as in the settings UI. A key may revoke
// itself; the response is still delivered.

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../lib/api-auth';
import { isApiKeyPrefix, revokeApiKey } from '../../../../../../lib/api-keys';

export const DELETE: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  if (ctx.permission !== 'admin') return apiError('Managing API keys requires admin permission on the site.', 403, ctx);
  if (!isApiKeyPrefix(params.prefix)) return apiError('API key not found', 404, ctx);
  const revoked = await revokeApiKey(ctx.orgId, ctx.siteId, params.prefix);
  if (!revoked) return apiError('API key not found', 404, ctx);
  return apiResponse(ctx, { ok: true, id: params.prefix });
};
