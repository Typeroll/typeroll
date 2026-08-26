// POST /api/v1/sites/{siteId}/domain/poll — refresh from Cloudflare.

import type { APIRoute } from 'astro';
import { requireApiKey, apiResponse, apiError } from '../../../../../../lib/api-auth';
import { pollDomainStatus, DomainServiceError } from '../../../../../../lib/site-domain';

export const POST: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  if (ctx.permission !== 'admin') {
    return apiError('Domain management requires admin permission on the site.', 403);
  }
  try {
    const state = await pollDomainStatus(ctx.orgId, ctx.siteId);
    return apiResponse(ctx, { domain: state });
  } catch (e) {
    if (e instanceof DomainServiceError) return apiError(e.message, e.status);
    return apiError(e instanceof Error ? e.message : String(e), 500);
  }
};
