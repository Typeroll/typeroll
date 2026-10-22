// Which Cloudflare account a site's Analytics (Cloudflare Web Analytics)
// belongs to, and how to call it.
//
// The account that hosts the site owns its analytics:
//   - customer publishing (`publishing_mode: customer_git`): the Cloudflare
//     account of the site's Hosting Group — the same connection publishing
//     uses (Default reuses the Organization's connection). Never the
//     installation's account, even when the Organization's connection is
//     missing or lacks permission.
//   - managed hosting (the older path) and self-hosted installs: the account
//     configured for the installation (CLOUDFLARE_ACCOUNT_ID /
//     CLOUDFLARE_API_TOKEN), which also hosts those sites.

import { paths, type AppProviderAccount, type Site } from '@typeroll/shared';
import { getStore } from '../datastore';
import { getConnection, openCredentials } from '../publishing/connections';
import { CLOUDFLARE_ANALYTICS_PROVISION_SCOPE, CLOUDFLARE_ANALYTICS_READ_SCOPE } from '../publishing/cloudflare-config';
import { generatedCloudflareNames } from '../publishing/cloudflare-account-claims';
import { getSiteDomains } from '../publishing/domain-config';
import { getHostingGroup } from '../publishing/hosting-groups';
import type { CloudflareStoredCredentials } from '../publishing/cloudflare-oauth';

export const ANALYTICS_SETTINGS_URL = '/app/settings/publishing';

/** A structured reason the Analytics app cannot reach a working state, with the step that fixes it. */
export class AnalyticsSetupError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly nextStep: string,
    readonly account?: AppProviderAccount,
    readonly settingsUrl?: string,
  ) {
    super(message);
    this.name = 'AnalyticsSetupError';
  }
}

export interface AnalyticsAccount extends AppProviderAccount {
  account_id: string;
  account_name: string | null;
  hosting_group_name?: string;
  /** OAuth scopes granted to the connection, or null when it uses an API token (permissions unknown until used). */
  scopes: string[] | null;
  withToken<T>(work: (token: string) => Promise<T>): Promise<T>;
}

export function accountRef(account: AppProviderAccount): AppProviderAccount {
  return {
    owner: account.owner,
    account_id: account.account_id,
    ...(account.hosting_group_id ? { hosting_group_id: account.hosting_group_id } : {}),
  };
}

export function describeAccount(account: Pick<AnalyticsAccount, 'owner' | 'account_id' | 'account_name' | 'hosting_group_name'>): string {
  if (account.owner === 'installation') return `this installation’s Cloudflare account (${account.account_id})`;
  const name = account.account_name ? `${account.account_name} (${account.account_id})` : account.account_id;
  return `the Cloudflare account ${name} of Hosting Group “${account.hosting_group_name ?? 'Default'}”`;
}

export function analyticsAccessNextStep(purpose: 'provision' | 'reports'): string {
  const permissions = purpose === 'provision'
    ? 'Account Settings (edit) to create the Web Analytics site and Account Analytics (read) for Insights'
    : 'Account Analytics (read)';
  return `In the site’s Settings → Core modules, select “Approve Analytics access” on Analytics; an organization owner or admin signs in to Cloudflare again and approves ${permissions} for the hosting account. ` +
    'A connection made with an API token needs the token permissions Account → Account Settings → Edit and Account → Account Analytics → Read instead. ' +
    (purpose === 'provision'
      ? 'Then enable Analytics again (update_app with app_id "analytics" and enabled: true). Without Account Settings (edit), you can instead create a Web Analytics site in that Cloudflare account and paste its token as beacon_token.'
      : 'Then reload Insights.');
}

/** Scopes are only known for OAuth connections; API tokens are checked by the provider's answer. */
export function hasScope(account: AnalyticsAccount, purpose: 'provision' | 'reports'): boolean {
  if (!account.scopes) return true;
  return account.scopes.includes(purpose === 'provision' ? CLOUDFLARE_ANALYTICS_PROVISION_SCOPE : CLOUDFLARE_ANALYTICS_READ_SCOPE);
}

/** Resolve the account that hosts this site. Throws AnalyticsSetupError when it cannot be used. */
export async function resolveAnalyticsAccount(orgId: string, site: Site | null | undefined, fetchImpl: typeof fetch = fetch): Promise<AnalyticsAccount> {
  if (site?.publishing_mode === 'customer_git') {
    const groupId = site.hosting_group_id ?? 'default';
    const group = await getHostingGroup(orgId, groupId);
    const connection = await getConnection(orgId, 'cloudflare', groupId);
    const pending: AppProviderAccount = { owner: 'organization', account_id: connection.cloudflare?.account_id ?? null, hosting_group_id: groupId };
    if (connection.status !== 'connected' || !connection.cloudflare || !connection.encrypted_credentials) {
      throw new AnalyticsSetupError('analytics_cloudflare_connection_required',
        `Analytics for this site lives in the Cloudflare account that hosts it, and Hosting Group “${group.name}” has no connected Cloudflare account.`,
        `Connect Cloudflare for Hosting Group “${group.name}” in Account → Publishing, then enable Analytics again (update_app with app_id "analytics" and enabled: true).`,
        pending, ANALYTICS_SETTINGS_URL);
    }
    let scopes: string[] | null;
    try {
      const credentials = openCredentials<CloudflareStoredCredentials>(orgId, 'cloudflare', connection.encrypted_credentials, groupId);
      scopes = credentials.oauth ? credentials.oauth.scope.split(/\s+/).filter(Boolean) : null;
    } catch {
      throw new AnalyticsSetupError('analytics_cloudflare_connection_required',
        `The Cloudflare connection of Hosting Group “${group.name}” cannot be read on this server.`,
        `Reconnect Cloudflare for Hosting Group “${group.name}” in Account → Publishing, then enable Analytics again.`,
        pending, ANALYTICS_SETTINGS_URL);
    }
    const { withCloudflareCredential } = await import('../publishing/cloudflare-oauth');
    return {
      owner: 'organization',
      account_id: connection.cloudflare.account_id,
      account_name: connection.cloudflare.account_name ?? null,
      hosting_group_id: groupId,
      hosting_group_name: group.name,
      scopes,
      withToken: (work) => withCloudflareCredential(orgId, groupId, work, fetchImpl),
    };
  }
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !apiToken) {
    throw new AnalyticsSetupError('analytics_account_not_configured',
      'This installation has no Cloudflare account configured for Analytics, so Typeroll cannot create the Web Analytics site or read its reports.',
      'Create a Web Analytics site in Cloudflare (Analytics & Logs → Web Analytics) and paste its token as beacon_token; reports are then available in the Cloudflare dashboard. ' +
        'A self-hosted installation can set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (Account Settings edit and Account Analytics read) to provision automatically and show Insights.',
      { owner: 'installation', account_id: null });
  }
  return {
    owner: 'installation',
    account_id: accountId,
    account_name: null,
    scopes: null,
    withToken: (work) => work(apiToken),
  };
}

/** The hostname Cloudflare labels the Web Analytics site with. Measurement itself works on any host the beacon runs on. */
export async function analyticsHostForSite(orgId: string, siteId: string, site: Site | null | undefined): Promise<string | null> {
  const strip = (value: string) => value.replace(/^https?:\/\//, '').replace(/[/:].*$/, '').toLowerCase();
  if (site?.publishing_mode === 'customer_git') {
    const domains = await getSiteDomains(orgId, siteId);
    const host = domains.active?.website_host ?? domains.desired.website_host;
    if (host) return host;
    if (site.domain) return strip(site.domain);
    const group = await getHostingGroup(orgId, site.hosting_group_id ?? 'default');
    const label = generatedCloudflareNames(orgId, siteId).site_label;
    return group.sites_domain && label ? `${label}.${group.sites_domain}` : null;
  }
  if (site?.domain) return strip(site.domain);
  const sub = site?.hosting_config?.fallback_subdomain;
  const base = process.env.SITES_BASE_DOMAIN;
  if (sub) return sub.includes('.') ? strip(sub) : base ? `${sub}.${base}` : null;
  return null;
}

export async function readSite(orgId: string, siteId: string): Promise<Site | null> {
  return getStore().getDoc<Site>(paths.site(orgId, siteId));
}
