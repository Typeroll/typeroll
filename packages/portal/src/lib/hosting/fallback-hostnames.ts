/**
 * Platform-wide registry of fallback hostnames (`{label}.{SITES_BASE_DOMAIN}`).
 *
 * Site ids and slugs are unique only within an organization, but the
 * fallback hostname lives in one shared DNS zone and is written with the
 * platform's Cloudflare token. Without a global claim, a second
 * organization could provision the same label and re-point another
 * customer's preview URL at its own Pages project.
 *
 * One root-level document per hostname records the owning site. A claim is
 * an atomic create-if-missing, so two concurrent requests cannot both win.
 * Hostnames provisioned before this registry existed have no claim
 * document; the Cloudflare checks in site-provisioning (never overwrite a
 * CNAME that points elsewhere, never adopt a domain another Pages project
 * holds) refuse those labels instead.
 */

import { getStore } from '../datastore';

/** Datastore paths. Root-level, outside any organization, by design. */
export const fallbackHostnamePaths = {
  collection: () => 'fallback_hostnames',
  entry: (hostname: string) => `fallback_hostnames/${hostname}`,
};

export interface FallbackHostnameClaim {
  hostname: string;
  org_id: string;
  site_id: string;
  claimed_at: string;
}

export interface FallbackHostnameOwner {
  orgId: string;
  siteId: string;
}

/** The hostname is claimed by another site, or Cloudflare shows it in use. */
export class FallbackHostnameUnavailableError extends Error {
  readonly status = 409;
  constructor(readonly hostname: string, detail?: string) {
    super(detail ?? `${hostname} is already used by another site.`);
    this.name = 'FallbackHostnameUnavailableError';
  }
}

const HOSTNAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

function normalize(hostname: string): string {
  const host = hostname.trim().toLowerCase().replace(/\.$/, '');
  if (!HOSTNAME_RE.test(host)) throw new Error(`Invalid fallback hostname: ${hostname}`);
  return host;
}

/**
 * Claim `hostname` for a site. Returns `{ created: true }` when this call
 * created the claim, `{ created: false }` when the same site already held
 * it, and throws FallbackHostnameUnavailableError when another site does.
 */
export async function claimFallbackHostname(hostname: string, owner: FallbackHostnameOwner): Promise<{ created: boolean }> {
  const host = normalize(hostname);
  const store = getStore();
  const path = fallbackHostnamePaths.entry(host);
  const claim: FallbackHostnameClaim = {
    hostname: host,
    org_id: owner.orgId,
    site_id: owner.siteId,
    claimed_at: new Date().toISOString(),
  };
  if (await store.createDocIfMissing(path, claim)) return { created: true };
  const existing = await store.getDoc<FallbackHostnameClaim>(path);
  if (existing && existing.org_id === owner.orgId && existing.site_id === owner.siteId) return { created: false };
  throw new FallbackHostnameUnavailableError(host);
}

/** Release a claim, only when `owner` holds it. */
export async function releaseFallbackHostname(hostname: string, owner: FallbackHostnameOwner): Promise<void> {
  const host = normalize(hostname);
  const store = getStore();
  const path = fallbackHostnamePaths.entry(host);
  const existing = await store.getDoc<FallbackHostnameClaim>(path);
  if (existing && existing.org_id === owner.orgId && existing.site_id === owner.siteId) await store.deleteDoc(path);
}
