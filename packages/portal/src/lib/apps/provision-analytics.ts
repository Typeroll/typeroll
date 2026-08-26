// Best-effort Cloudflare Web Analytics provisioning when the analytics app
// is enabled. Fills a missing beacon_token (+ site_tag) by creating a CF
// Web Analytics site for the site's host. Entirely optional: without CF
// creds or a resolvable host it no-ops and the owner pastes a token by
// hand. Never throws — provisioning failure must not block enabling.

import type { AppState, Site } from '@typeroll/shared';

/** The host CF should attribute analytics to: custom domain first, else
 *  the fallback subdomain, else nothing (can't provision). */
function hostForSite(site: Site | undefined): string | null {
  if (!site) return null;
  if (site.domain) return site.domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const sub = site.hosting_config?.fallback_subdomain;
  const base = process.env.SITES_BASE_DOMAIN;
  if (sub && base) return `${sub}.${base}`;
  return null;
}

/**
 * Returns config patches to merge into the analytics config (possibly
 * empty). Only provisions when: a beacon token isn't already set, CF creds
 * exist, and a host is resolvable.
 */
export async function maybeProvisionWebAnalytics(
  site: Site | undefined,
  incoming: Record<string, unknown>,
  existing: AppState | undefined,
): Promise<Record<string, unknown>> {
  const alreadyHaveToken =
    (typeof incoming.beacon_token === 'string' && incoming.beacon_token.trim()) ||
    (typeof existing?.config?.beacon_token === 'string' && (existing.config.beacon_token as string).trim());
  if (alreadyHaveToken) return {};

  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !apiToken) return {};

  const host = hostForSite(site);
  if (!host) return {};

  try {
    const { CloudflareApi } = await import('../hosting/cloudflare-api');
    const cf = new CloudflareApi({ accountId, apiToken });
    const result = await cf.createWebAnalyticsSite(host);
    if (!result) return {};
    return { beacon_token: result.beacon_token, site_tag: result.site_tag };
  } catch (e) {
    console.warn('[apps/analytics] Web Analytics provisioning failed (falling back to manual token):', e);
    return {};
  }
}
