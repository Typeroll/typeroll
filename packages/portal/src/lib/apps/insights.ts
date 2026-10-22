// Insights service — reads a site's traffic from Cloudflare Web Analytics
// (when the analytics app is enabled and a site_tag is available) and folds
// in the AI-assistant referral breakdown. Reports are read from the same
// Cloudflare account the beacon belongs to: the account that hosts the site
// (analytics-account.ts). Every "can't read stats" condition returns a typed
// status with the cause and next step; Cloudflare failures are not reported
// as an empty period.

import type { AppProviderAccount, Site, SiteApps } from '@typeroll/shared';
import { resolveAppConfig } from './config';
import { aggregateAiReferrals, type RefererRow } from './ai-referrers';
import type { ConversionInsights } from './analytics-events';
import { analyticsSetupView } from './analytics-setup';
import {
  accountRef, analyticsAccessNextStep, AnalyticsSetupError, ANALYTICS_SETTINGS_URL, describeAccount, hasScope, resolveAnalyticsAccount, type AnalyticsAccount,
} from './analytics-account';
import { ownedByOtherOrganization, providerSetupError } from './provision-analytics';
import { webAnalyticsApi } from './web-analytics-api';

export type InsightsStatus =
  | 'ok'
  | 'app_disabled'        // analytics app not enabled for this site
  | 'not_configured'      // managed/self-hosted: no Cloudflare account configured for the installation
  | 'no_site_tag'         // enabled but not yet provisioned/linked to a Web Analytics site
  | 'connection_required' // customer publishing: the Hosting Group has no usable Cloudflare connection
  | 'access_required'     // the hosting account's connection may not read Web Analytics reports
  | 'account_mismatch'    // the saved Web Analytics site is not in the account that hosts the site
  | 'provider_error'      // Cloudflare did not answer; retry
  | 'no_data';            // linked, but Cloudflare has no traffic for the period (site brand new)

export interface InsightsReason {
  code: string;
  message: string;
  next_step: string;
  settings_url?: string;
}

export interface InsightsResult {
  status: InsightsStatus;
  days: number;
  total_visits: number;
  total_pageviews: number;
  top_referrers: RefererRow[];
  ai_referrals: ReturnType<typeof aggregateAiReferrals>;
  conversions: ConversionInsights;
  /** The account reports are read from, when known. */
  account?: AppProviderAccount;
  /** Why traffic is unavailable and what fixes it; absent for ok, no_data and app_disabled. */
  reason?: InsightsReason;
}

const EMPTY_CONVERSIONS: ConversionInsights = {
  total_events: 0,
  by_event: [],
  by_source: [],
  by_campaign: [],
  truncated: false,
};

const EMPTY = (status: InsightsStatus, days: number, extra: Pick<InsightsResult, 'account' | 'reason'> = {}): InsightsResult => ({
  status, days, total_visits: 0, total_pageviews: 0,
  top_referrers: [], ai_referrals: aggregateAiReferrals([]), conversions: EMPTY_CONVERSIONS,
  ...(extra.account ? { account: extra.account } : {}),
  ...(extra.reason ? { reason: extra.reason } : {}),
});

const reasonOf = (error: AnalyticsSetupError): InsightsReason => ({
  code: error.code, message: error.message, next_step: error.nextStep, ...(error.settingsUrl ? { settings_url: error.settingsUrl } : {}),
});

const STATUS_BY_CODE: Record<string, InsightsStatus> = {
  analytics_cloudflare_connection_required: 'connection_required',
  analytics_cloudflare_access_required: 'access_required',
  analytics_account_not_configured: 'not_configured',
  analytics_account_mismatch: 'account_mismatch',
  analytics_site_owned_by_other_organization: 'account_mismatch',
};

export async function getInsights(args: {
  orgId: string;
  siteId: string;
  site: Site | null | undefined;
  appsDoc: SiteApps | undefined;
  days?: number;
  fetchImpl?: typeof fetch;
}): Promise<InsightsResult> {
  const days = args.days ?? 30;
  const fetchImpl = args.fetchImpl ?? fetch;
  const state = args.appsDoc?.apps?.analytics;
  if (!state?.enabled) return EMPTY('app_disabled', days);

  let account: AnalyticsAccount;
  try {
    account = await resolveAnalyticsAccount(args.orgId, args.site, fetchImpl);
  } catch (error) {
    if (!(error instanceof AnalyticsSetupError)) throw error;
    return EMPTY(STATUS_BY_CODE[error.code] ?? 'connection_required', days, {
      ...(error.account ? { account: accountRef(error.account) } : {}), reason: reasonOf(error),
    });
  }
  const ref = accountRef(account);
  const fail = (status: InsightsStatus, error: AnalyticsSetupError) => EMPTY(status, days, { account: ref, reason: reasonOf(error) });

  const siteTag = String(resolveAppConfig('analytics', state).site_tag ?? '').trim();
  if (!siteTag) {
    const setup = analyticsSetupView(state);
    return EMPTY('no_site_tag', days, {
      account: ref,
      reason: setup?.status === 'action_required' && setup.code && setup.message && setup.next_step
        ? { code: setup.code, message: setup.message, next_step: setup.next_step, ...(setup.settings_url ? { settings_url: setup.settings_url } : {}) }
        : {
          code: 'analytics_not_provisioned',
          message: 'Analytics is enabled, but no Cloudflare Web Analytics site is linked.',
          next_step: 'Enable Analytics again (update_app with app_id "analytics" and enabled: true) to create it in the Cloudflare account that hosts the site, then redeploy.',
        },
    });
  }

  const where = describeAccount(account);
  const mismatch = () => fail('account_mismatch', new AnalyticsSetupError('analytics_account_mismatch',
    `The saved Web Analytics site is not in ${where}, which hosts this site, so its reports cannot be read there.`,
    'Clear beacon_token and site_tag and enable Analytics again (update_app with config {"beacon_token": "", "site_tag": ""} and enabled: true) to create the site in the hosting account, then redeploy the site.'));
  // The account a verified (ready) setup recorded for this beacon. An action-required setup names only the target account.
  const recorded = state.setup?.status === 'ready' ? state.setup.account : undefined;
  if (recorded?.account_id && (recorded.account_id !== account.account_id || recorded.owner !== account.owner)) return mismatch();
  if (await ownedByOtherOrganization(args.orgId, account, siteTag)) return mismatch();

  if (!hasScope(account, 'reports')) {
    return fail('access_required', new AnalyticsSetupError('analytics_cloudflare_access_required',
      `The Cloudflare connection for ${where} has not been allowed to read Web Analytics reports (Account Analytics read).`,
      analyticsAccessNextStep('reports'), ref, ANALYTICS_SETTINGS_URL));
  }

  try {
    const data = await account.withToken(async (token) => {
      const api = webAnalyticsApi(token, account.account_id, fetchImpl);
      // A beacon not verified in this account (saved before accounts were recorded, or awaiting an action):
      // confirm the site is in the hosting account first, so a foreign site never reads as an empty period.
      if (!recorded?.account_id && account.owner === 'organization' && !(await api.getSite(siteTag))) return null;
      return api.trafficByReferer(siteTag, days);
    });
    if (!data) return mismatch();
    const referrers = data.by_referer
      .filter((r) => r.referer && r.referer !== '(direct)')
      .slice(0, 15);
    return {
      status: data.total_pageviews === 0 ? 'no_data' : 'ok',
      days,
      total_visits: data.total_visits,
      total_pageviews: data.total_pageviews,
      top_referrers: referrers,
      ai_referrals: aggregateAiReferrals(data.by_referer),
      conversions: EMPTY_CONVERSIONS,
      account: ref,
    };
  } catch (error) {
    const failure = providerSetupError(error, account, 'reports');
    return fail(STATUS_BY_CODE[failure.code] ?? 'provider_error', failure);
  }
}
