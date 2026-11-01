// Cloudflare Web Analytics setup when the Analytics app is enabled or its
// token changes. The Web Analytics site is created in, and a pasted token is
// resolved against, the Cloudflare account that hosts the site (see
// analytics-account.ts). The outcome is recorded as the app's `setup` status
// and returned to every caller (portal, HTTP API, MCP): a failure carries a
// stable code, a message and the next step. Nothing fails silently.

import type { AppProviderAccount, AppSetupStatus, AppState, Site } from '@typeroll/shared';
import { ConnectionError } from '../publishing/connections';
import { claimCloudflareResource, cloudflareResourceOwner } from '../publishing/cloudflare-account-claims';
import {
  accountRef, analyticsAccessNextStep, analyticsAccessSettingsUrl, analyticsHostForSite, AnalyticsSetupError, ANALYTICS_SETTINGS_URL, describeAccount, hasScope,
  resolveAnalyticsAccount, type AnalyticsAccount,
} from './analytics-account';
import { UNPROXIED_SITE_LIMIT, webAnalyticsApi, WebAnalyticsProviderError, type WebAnalyticsSite } from './web-analytics-api';

export interface AnalyticsReconciliation {
  /** Config values to merge into the saved app config. */
  patch: Record<string, unknown>;
  setup: AppSetupStatus;
  /** Set when the request must not be saved at all (for example a token from another account). */
  reject?: AnalyticsSetupError;
}

const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';

export function setupFromError(error: AnalyticsSetupError, now = new Date()): AppSetupStatus {
  return {
    status: 'action_required', code: error.code, message: error.message, next_step: error.nextStep,
    ...(error.settingsUrl ? { settings_url: error.settingsUrl } : {}),
    ...(error.account ? { account: accountRef(error.account) } : {}),
    checked_at: now.toISOString(),
  };
}

/** Translate a Cloudflare failure into a setup error for this account and purpose. */
export function providerSetupError(error: unknown, account: AnalyticsAccount, purpose: 'provision' | 'resolve' | 'reports'): AnalyticsSetupError {
  const where = describeAccount(account);
  const ref = accountRef(account);
  if (error instanceof AnalyticsSetupError) return error;
  if (error instanceof ConnectionError && error.code === 'cloudflare_resource_owned_by_other_organization') {
    return new AnalyticsSetupError('analytics_site_owned_by_other_organization',
      `This Web Analytics site in ${where} belongs to another Typeroll Organization that uses the same Cloudflare account.`,
      'Use a Web Analytics site created for this site: clear beacon_token and site_tag and enable Analytics again to create one.', ref);
  }
  if (error instanceof ConnectionError) {
    // The Organization's authorization could not be used (revoked, being renewed, changed).
    return new AnalyticsSetupError('analytics_cloudflare_connection_required',
      `The Cloudflare connection for ${where} could not be used: ${error.message}`,
      'Check the Hosting Group’s Cloudflare account in Account → Publishing (Check again, or reconnect), then enable Analytics again.', ref, ANALYTICS_SETTINGS_URL);
  }
  if (error instanceof WebAnalyticsProviderError) {
    if (error.kind === 'access') {
      return new AnalyticsSetupError('analytics_cloudflare_access_required',
        purpose === 'reports'
          ? `Cloudflare refused to return Web Analytics reports from ${where} (HTTP ${error.status}). The connection needs Account Analytics (read).`
          : purpose === 'provision'
            ? `Cloudflare refused to create a Web Analytics site in ${where} (HTTP ${error.status}). The connection needs Account Settings (edit).`
            : `Cloudflare refused to list Web Analytics sites in ${where} (HTTP ${error.status}). The connection needs Account Settings (read).`,
        analyticsAccessNextStep(purpose === 'reports' ? 'reports' : 'provision', account), ref,
        account.owner === 'organization' ? analyticsAccessSettingsUrl(purpose === 'reports' ? 'reports' : 'provision', account) : undefined);
    }
    const codes = error.codes.length ? `, Cloudflare codes ${error.codes.join(', ')}` : '';
    if (error.kind === 'site_limit') {
      return new AnalyticsSetupError('analytics_site_limit',
        `Cloudflare refused to add another Web Analytics site in ${where} (HTTP ${error.status}${codes}). The account already has ${UNPROXIED_SITE_LIMIT} or more sites, and Cloudflare allows ${UNPROXIED_SITE_LIMIT} sites added by hostname per account.`,
        'Remove a Web Analytics site you no longer use in Cloudflare → Analytics & Logs → Web Analytics, or ask Cloudflare support to raise this soft limit. Then enable Analytics again.', ref);
    }
    if (error.kind === 'rate_limited') {
      return new AnalyticsSetupError('analytics_provider_rate_limited',
        `Cloudflare rate-limited the Web Analytics request for ${where} (HTTP 429${codes}).`,
        'Wait a minute and try again.', ref);
    }
    return new AnalyticsSetupError('analytics_provider_error',
      `Cloudflare Web Analytics did not complete the request for ${where} (${error.status ? `HTTP ${error.status}` : 'no response'}${codes}).`,
      'Try again. If it keeps failing, check the account’s status in the Cloudflare dashboard.', ref);
  }
  return new AnalyticsSetupError('analytics_provider_error',
    `The Web Analytics request for ${where} failed unexpectedly.`, 'Try again.', ref);
}

async function claim(orgId: string, siteId: string, account: AnalyticsAccount, site: WebAnalyticsSite) {
  if (!/^[a-z0-9][a-z0-9_-]{0,127}$/.test(site.site_tag)) return;
  await claimCloudflareResource(orgId, account.account_id, 'web_analytics_site', site.site_tag, { siteId });
}

/** True when another Organization recorded this Web Analytics site as its own. */
export async function ownedByOtherOrganization(orgId: string, account: AppProviderAccount, siteTag: string): Promise<boolean> {
  if (!account.account_id || !/^[a-z0-9][a-z0-9_-]{0,127}$/.test(siteTag)) return false;
  const owner = await cloudflareResourceOwner(account.account_id, 'web_analytics_site', siteTag);
  return Boolean(owner && owner !== orgId);
}

/**
 * Bring the Analytics app's Cloudflare Web Analytics site in line with the account that hosts the site.
 * - No token: create a Web Analytics site in that account and fill beacon_token and site_tag.
 * - A new or changed token: find its site in that account and fill site_tag.
 * - An unchanged token already verified in that account: nothing to do.
 */
export async function reconcileWebAnalytics(args: {
  orgId: string;
  siteId: string;
  site: Site | null | undefined;
  incoming: Record<string, unknown>;
  existing: AppState | undefined;
  fetchImpl?: typeof fetch;
  now?: Date;
}): Promise<AnalyticsReconciliation> {
  const { orgId, siteId, site, incoming, existing } = args;
  const fetchImpl = args.fetchImpl ?? fetch;
  const now = args.now ?? new Date();
  const ready = (account: AnalyticsAccount, patch: Record<string, unknown> = {}): AnalyticsReconciliation =>
    ({ patch, setup: { status: 'ready', account: accountRef(account), checked_at: now.toISOString() } });
  const actionRequired = (error: AnalyticsSetupError, patch: Record<string, unknown> = {}): AnalyticsReconciliation =>
    ({ patch, setup: setupFromError(error, now) });

  const previousToken = text(existing?.config?.beacon_token);
  const previousTag = text(existing?.config?.site_tag);
  const token = Object.hasOwn(incoming, 'beacon_token') ? text(incoming.beacon_token) : previousToken;
  const requestedTag = Object.hasOwn(incoming, 'site_tag') ? text(incoming.site_tag) : previousTag;
  const tokenChanged = token !== previousToken;

  let account: AnalyticsAccount;
  try {
    account = await resolveAnalyticsAccount(orgId, site, fetchImpl);
  } catch (error) {
    if (!(error instanceof AnalyticsSetupError)) throw error;
    if (token && site?.publishing_mode === 'customer_git' && tokenChanged) {
      // A pasted token for customer publishing must come from the hosting account, which cannot be checked now.
      return { ...actionRequired(error), reject: error };
    }
    if (token && error.code === 'analytics_account_not_configured') {
      return actionRequired(new AnalyticsSetupError(error.code,
        'The beacon is published with this token, but this installation has no Cloudflare account configured, so Insights cannot read its reports. View them in the Cloudflare dashboard.',
        'A self-hosted installation can set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN for the account that owns this token to show Insights.',
        error.account));
    }
    return actionRequired(error);
  }
  const ref = accountRef(account);
  const where = describeAccount(account);
  // Only a ready setup records the account the beacon was verified in.
  const recorded = existing?.setup?.status === 'ready' ? existing.setup.account : undefined;

  if (token) {
    if (!tokenChanged && requestedTag === previousTag && previousTag &&
      recorded?.account_id === account.account_id && recorded.owner === account.owner) {
      return ready(account);
    }
    if (!tokenChanged && recorded?.account_id && (recorded.account_id !== account.account_id || recorded.owner !== account.owner)) {
      return actionRequired(new AnalyticsSetupError('analytics_account_mismatch',
        `The saved Web Analytics site belongs to a different Cloudflare account than the one that now hosts this site (${where}).`,
        'Clear beacon_token and site_tag and enable Analytics again (update_app with config {"beacon_token": "", "site_tag": ""} and enabled: true) to create the site in the hosting account, then redeploy the site.',
        ref));
    }
    let found: WebAnalyticsSite | null;
    try {
      found = await account.withToken(async (credential) => {
        const api = webAnalyticsApi(credential, account.account_id, fetchImpl);
        // A known tag is checked directly; otherwise the account's sites are searched for the token.
        const tagged = requestedTag ? await api.getSite(requestedTag) : null;
        return tagged?.site_token === token ? tagged : api.findByToken(token);
      });
    } catch (error) {
      const failure = providerSetupError(error, account, 'resolve');
      return tokenChanged && site?.publishing_mode === 'customer_git' ? { ...actionRequired(failure), reject: failure } : actionRequired(failure);
    }
    if (!found) {
      const failure = new AnalyticsSetupError('analytics_token_not_in_account',
        `This beacon_token does not belong to a Web Analytics site in ${where}, which hosts this site. Insights reads only the account that hosts the site.`,
        'Paste the token of a Web Analytics site in that account, or clear beacon_token and site_tag and enable Analytics again to create one there.',
        ref);
      // Customer publishing keeps analytics in the Organization's hosting account; a foreign token is not saved.
      // Managed and self-hosted sites keep accepting a token for beacon-only measurement, as before.
      return site?.publishing_mode === 'customer_git' && tokenChanged ? { ...actionRequired(failure), reject: failure } : actionRequired(failure);
    }
    const tagSupplied = Object.hasOwn(incoming, 'site_tag') && requestedTag !== '' && requestedTag !== previousTag;
    if (tagSupplied && requestedTag !== found.site_tag) {
      const failure = new AnalyticsSetupError('analytics_site_tag_mismatch',
        'The site_tag does not belong to the Web Analytics site of this beacon_token.',
        'Omit site_tag: Typeroll fills it from the token.', ref);
      return { ...actionRequired(failure), reject: failure };
    }
    try { await claim(orgId, siteId, account, found); }
    catch (error) {
      const failure = providerSetupError(error, account, 'resolve');
      return { ...actionRequired(failure), reject: failure };
    }
    return ready(account, { site_tag: found.site_tag });
  }

  // No token yet: create the Web Analytics site in the hosting account.
  if (!hasScope(account, 'provision')) {
    return actionRequired(new AnalyticsSetupError('analytics_cloudflare_access_required',
      `The Cloudflare connection for ${where} has not been allowed to create Web Analytics sites (Account Settings edit).`,
      analyticsAccessNextStep('provision', account), ref, analyticsAccessSettingsUrl('provision', account)));
  }
  const host = await analyticsHostForSite(orgId, siteId, site);
  if (!host) {
    return actionRequired(new AnalyticsSetupError('analytics_host_required',
      'Typeroll needs the site’s address to create its Web Analytics site, and this site has none yet.',
      site?.publishing_mode === 'customer_git'
        ? 'Set a website host in the site’s Publishing domains, or a site address base for its Hosting Group, then enable Analytics again.'
        : 'Set the site’s domain, then enable Analytics again.',
      ref, site?.publishing_mode === 'customer_git' ? ANALYTICS_SETTINGS_URL : undefined));
  }
  try {
    const created = await account.withToken((credential) => webAnalyticsApi(credential, account.account_id, fetchImpl).createSite(host));
    await claim(orgId, siteId, account, created);
    return ready(account, { beacon_token: created.site_token, site_tag: created.site_tag });
  } catch (error) {
    return actionRequired(providerSetupError(error, account, 'provision'));
  }
}
