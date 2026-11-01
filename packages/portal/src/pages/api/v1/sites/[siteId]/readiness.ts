// GET /api/v1/sites/{siteId}/readiness
// Site launch readiness: warnings and suggestions with fixes and guide links.
// Read-only; it never blocks a publication or changes content or zone settings.

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../lib/api-auth';
import { getStore } from '../../../../../lib/datastore';
import { siteReadinessReport } from '../../../../../lib/site-readiness-load';

export const GET: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  try {
    return apiResponse(ctx, await siteReadinessReport(getStore(), ctx.orgId, ctx.site, ctx.versionId));
  } catch (error) {
    return apiError(error instanceof Error ? error.message : 'Readiness check failed', 400);
  }
};
