import type { APIRoute } from 'astro';
import { apiResponse, requireApiKey } from '../../../../../lib/api-auth';
import { getStore } from '../../../../../lib/datastore';
import { buildMigrationLaunchReport } from '../../../../../lib/migration-launch-report';

export const GET: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const report = await buildMigrationLaunchReport({
    store: getStore(),
    orgId: ctx.orgId,
    siteId: ctx.siteId,
    versionId: ctx.versionId,
    site: ctx.site,
  });
  return apiResponse(ctx, report);
};
