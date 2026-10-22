// GET /api/v1/sites/{siteId}/insights — bearer-key read of the site's
// traffic + AI-referral breakdown (analytics app). Same payload as the
// cookie route; returns a status, and a reason with the next step, when
// traffic cannot be read rather than erroring.

import type { APIRoute } from 'astro';
import { apiResponse, requireApiKey } from '../../../../../lib/api-auth';
import { getStore } from '../../../../../lib/datastore';
import { paths } from '@typeroll/shared';
import type { SiteApps } from '@typeroll/shared';
import { getInsights } from '../../../../../lib/apps/insights';

export const GET: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;

  const daysRaw = Number(new URL(request.url).searchParams.get('days'));
  const days = [7, 30, 90].includes(daysRaw) ? daysRaw : 30;

  const appsDoc = await getStore().getDoc<SiteApps>(paths.apps(ctx.orgId, ctx.siteId));
  const result = await getInsights({ orgId: ctx.orgId, siteId: ctx.siteId, site: ctx.site, appsDoc: appsDoc ?? undefined, days });
  return apiResponse(ctx, result);
};
