// Site insights (traffic + AI-referral breakdown). Read-level: anyone with
// access to the site can view its stats. Data comes from the analytics app
// (Cloudflare Web Analytics); when the app is off or unconfigured the
// payload carries a status the UI explains rather than an error.

import type { APIRoute } from 'astro';
import { requireSiteAccess, json } from '../../../../lib/access';
import { getStore } from '../../../../lib/datastore';
import { paths } from '@typeroll/shared';
import type { SiteApps } from '@typeroll/shared';
import { getInsights } from '../../../../lib/apps/insights';
import { getConversionInsights } from '../../../../lib/apps/analytics-events';

export const GET: APIRoute = async ({ cookies, params, locals, request }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const { site, owner_org_id } = guard.value;

  const daysRaw = Number(new URL(request.url).searchParams.get('days'));
  const days = [7, 30, 90].includes(daysRaw) ? daysRaw : 30;

  const store = getStore();
  const appsDoc = await store.getDoc<SiteApps>(paths.apps(owner_org_id, site.id));
  const [result, conversions] = await Promise.all([
    getInsights(appsDoc ?? undefined, days),
    appsDoc?.apps?.analytics?.enabled
      ? getConversionInsights(store, owner_org_id, site.id, days)
      : Promise.resolve({ total_events: 0, by_event: [], by_source: [], by_campaign: [], truncated: false }),
  ]);
  return json({ ...result, conversions });
};
