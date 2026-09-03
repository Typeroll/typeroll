// GET /api/v1/sites/{siteId}/internal-links

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../lib/api-auth';
import { getStore } from '../../../../../lib/datastore';
import { checkInternalLinks } from '../../../../../lib/internal-link-check';

export const GET: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  try {
    const report = await checkInternalLinks({
      store: getStore(),
      orgId: ctx.orgId,
      siteId: ctx.siteId,
      versionId: ctx.versionId,
      site: ctx.site,
    });
    return apiResponse(ctx, report);
  } catch (error) {
    return apiError(error instanceof Error ? error.message : 'Internal link check failed', 400);
  }
};
