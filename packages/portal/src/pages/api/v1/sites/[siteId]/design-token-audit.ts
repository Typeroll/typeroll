import type { APIRoute } from 'astro';
import { apiResponse, requireApiKey } from '../../../../../lib/api-auth';
import { readDesignTokenAudit } from '../../../../../lib/design-token-audit';
export const GET: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  return apiResponse(ctx, await readDesignTokenAudit(ctx.orgId, ctx.siteId, ctx.versionId));
};
