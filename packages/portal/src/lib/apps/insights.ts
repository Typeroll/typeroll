// Insights service — reads a site's traffic from Cloudflare Web Analytics
// (when the analytics app is enabled and a site_tag is available) and folds
// in the AI-assistant referral breakdown. Degrades gracefully: every
// "can't read stats yet" condition returns a typed status the UI explains,
// never an error.

import type { SiteApps } from '@typeroll/shared';
import { resolveAppConfig } from './config';
import { aggregateAiReferrals, type RefererRow } from './ai-referrers';
import type { ConversionInsights } from './analytics-events';

export type InsightsStatus =
  | 'ok'
  | 'app_disabled'      // analytics app not enabled for this site
  | 'not_configured'    // no CF creds on the server
  | 'no_site_tag'       // enabled but not yet provisioned/linked to a CF site
  | 'no_data';          // linked, but CF returned nothing (site brand new)

export interface InsightsResult {
  status: InsightsStatus;
  days: number;
  total_visits: number;
  total_pageviews: number;
  top_referrers: RefererRow[];
  ai_referrals: ReturnType<typeof aggregateAiReferrals>;
  conversions: ConversionInsights;
}

const EMPTY_CONVERSIONS: ConversionInsights = {
  total_events: 0,
  by_event: [],
  by_source: [],
  by_campaign: [],
  truncated: false,
};

const EMPTY = (status: InsightsStatus, days: number): InsightsResult => ({
  status, days, total_visits: 0, total_pageviews: 0,
  top_referrers: [], ai_referrals: aggregateAiReferrals([]), conversions: EMPTY_CONVERSIONS,
});

export async function getInsights(
  appsDoc: SiteApps | undefined,
  days = 30,
): Promise<InsightsResult> {
  const state = appsDoc?.apps?.analytics;
  if (!state?.enabled) return EMPTY('app_disabled', days);

  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !apiToken) return EMPTY('not_configured', days);

  const siteTag = String(resolveAppConfig('analytics', state).site_tag ?? '');
  if (!siteTag) return EMPTY('no_site_tag', days);

  const { CloudflareApi } = await import('../hosting/cloudflare-api');
  const cf = new CloudflareApi({ accountId, apiToken });
  const data = await cf.webAnalyticsByReferer(siteTag, days);
  if (!data) return EMPTY('no_data', days);

  const referrers = data.by_referer
    .filter((r) => r.referer && r.referer !== '(direct)')
    .slice(0, 15);

  return {
    status: (data.total_pageviews === 0 ? 'no_data' : 'ok'),
    days,
    total_visits: data.total_visits,
    total_pageviews: data.total_pageviews,
    top_referrers: referrers,
    ai_referrals: aggregateAiReferrals(data.by_referer),
    conversions: EMPTY_CONVERSIONS,
  };
}
