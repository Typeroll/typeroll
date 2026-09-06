import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../lib/api-auth';
import { vstore } from '../../../../../lib/version-store';
import { diagnoseSiteIndexing } from '../../../../../lib/indexing-diagnostics';

export const GET: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const settings = await vstore.settings(ctx.orgId, ctx.siteId, ctx.versionId);
  if (!settings) return apiError('Site settings not found', 404);

  const report = await diagnoseSiteIndexing(ctx.site, settings);
  return apiResponse(ctx, report);
};
