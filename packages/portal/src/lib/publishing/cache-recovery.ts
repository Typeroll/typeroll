import { getStore } from '../datastore';
import type { StaticObservation } from '../builds/verification';
import { ConnectionError } from './connections';
import { findPublishingZone } from './domain-provider';
import { hostingDns } from './hosting-dns';
import { publicationHostname } from './domain-config';
import type { ProviderClient } from './providers.mjs';

export interface CacheRecovery {
  publication_id: string;
  hostname: string;
  route: string;
  zone_id: string;
  zone_name: string;
  dns_account_id: string;
  dns_group_id: string;
  state: 'targeted_purge' | 'approval_required' | 'zone_approved' | 'zone_purged';
  targeted_attempts: number;
  observations_after_purge?: number;
  updated_at: string;
}
type Publication = { publication_id: string; hosting_group_id?: string };
type RecoveryJob = { cache_recovery?: CacheRecovery; static_probe?: StaticObservation & { origin: string } };

/** A successful API purge is not proof that stale Pages bytes disappeared. */
export function isCachedStaticMismatch(probe: RecoveryJob['static_probe'], origin: string): boolean {
  if (!probe || probe.origin !== origin || probe.actual_status !== 200 ||
      !(probe.expected_status === 404 || probe.reason === 'content_mismatch')) return false;
  const cache = probe.response_headers?.cf_cache_status;
  const age = Number(probe.response_headers?.age);
  return ['HIT', 'REVALIDATED', 'STALE', 'UPDATING'].includes(String(cache)) ||
    (cache === 'MISS' && Number.isFinite(age) && age > 0);
}

const required = (state: CacheRecovery) => new ConnectionError(
  `Cloudflare still serves old files at https://${state.hostname}${state.route} despite the publication cache refresh. The build is complete; do not rebuild. An organization administrator can approve refreshing the cache for the whole ${state.zone_name} zone, including its other subdomains, then resume verification of this same publication. Files and DNS will not change.`,
  409, 'publication_cache_refresh_required');

/** Called under the publication target lease, only after candidate and marker verification. */
export async function recoverPublicationCache(org: string, jobPath: string, publication: Publication, origin: string,
  dns?: { provider: ProviderClient; accountId: string; groupId: string } | null, allowTargeted = true) {
  const store = getStore(), job = await store.getDoc<RecoveryJob>(jobPath);
  if (!isCachedStaticMismatch(job?.static_probe, origin)) return;
  const hostname = publicationHostname(new URL(origin).hostname), route = job!.static_probe!.route;
  const url = new URL(route, origin);
  if (!route.startsWith('/') || route.startsWith('//') || url.origin !== origin || url.pathname !== route || url.search || url.hash) return;
  if (dns === undefined) {
    try { dns = await hostingDns(org, publication.hosting_group_id ?? 'default', hostname); }
    catch (error) { if (error instanceof ConnectionError && error.code === 'domain_zone_required') dns = null; else throw error; }
  }
  if (!dns) throw new ConnectionError(`The build is complete, but the external hosting cache still serves old content at ${route}. Refresh the cache for ${hostname} at your DNS/CDN provider, then retry verification of this same publication.`, 409, 'publication_cache_refresh_external');
  const zone = await findPublishingZone(dns.provider, dns.accountId, hostname);
  const previous = job?.cache_recovery?.publication_id === publication.publication_id ? job.cache_recovery : undefined;
  const sameZone = previous && previous.zone_id === zone.id && previous.dns_account_id === dns.accountId;
  const samePath = sameZone && previous.hostname === hostname && previous.route === route;
  // Purge propagation has no callback. Observe with the existing bounded queue
  // backoff; never repeat the purge or restart a build while waiting.
  if (sameZone && (previous.state === 'zone_purged' || (allowTargeted && samePath && previous.state === 'targeted_purge')) &&
      (previous.observations_after_purge ?? 0) < 5) {
    await store.updateDoc(jobPath, { cache_recovery: { ...previous, observations_after_purge: (previous.observations_after_purge ?? 0) + 1 }, phase: 'verifying refreshed cache' });
    return;
  }
  if (sameZone && previous.state === 'zone_purged') throw new ConnectionError(
    `Cloudflare still serves old content at ${route} after the approved zone cache refresh. No new build or repeated purge was started. Check Cloudflare cache rules or contact Cloudflare with static_probe.cf_ray, then retry verification.`, 409, 'publication_cache_refresh_failed');
  const state: CacheRecovery = {
    publication_id: publication.publication_id, hostname, route, zone_id: zone.id, zone_name: zone.name,
    dns_account_id: dns.accountId, dns_group_id: dns.groupId, state: 'targeted_purge',
    targeted_attempts: (previous?.targeted_attempts ?? 0) + 1, observations_after_purge: 0, updated_at: new Date().toISOString(),
  };
  if (!allowTargeted || samePath || (previous?.targeted_attempts ?? 0) >= 3) {
    await store.updateDoc(jobPath, { cache_recovery: { ...state, state: 'approval_required', targeted_attempts: previous?.targeted_attempts ?? 0 } });
    throw required(state);
  }
  // Purge every cache-key variant of this path prefix, never the entire zone.
  await dns.provider(`/zones/${zone.id}/purge_cache`, { method: 'POST', body: { prefixes: [hostname + route] } });
  await store.updateDoc(jobPath, { cache_recovery: state, phase: 'refreshing cached publication files',
    verification_message: `Refreshing Cloudflare's cache for ${route}. The same published files will be checked again; no rebuild is needed.` });
}

/** Zone-wide recovery is a separate, explicit org-admin approval bound to one job and zone. */
export async function applyApprovedCacheRefresh(org: string, jobPath: string, publication: Publication) {
  const store = getStore(), state = (await store.getDoc<RecoveryJob>(jobPath))?.cache_recovery;
  if (!state || state.state !== 'zone_approved') return false;
  if (state.publication_id !== publication.publication_id) throw new ConnectionError('The cache recovery publication changed.', 409, 'publication_cache_scope_changed');
  const dns = await hostingDns(org, publication.hosting_group_id ?? 'default', state.hostname);
  const zone = await findPublishingZone(dns.provider, dns.accountId, state.hostname);
  if (zone.id !== state.zone_id || zone.name !== state.zone_name || dns.accountId !== state.dns_account_id || dns.groupId !== state.dns_group_id)
    throw new ConnectionError('The connected DNS account or zone changed. Review cache recovery again before approving it.', 409, 'publication_cache_scope_changed');
  await dns.provider(`/zones/${zone.id}/purge_cache`, { method: 'POST', body: { purge_everything: true } });
  await store.updateDoc(jobPath, { cache_recovery: { ...state, state: 'zone_purged', observations_after_purge: 0, updated_at: new Date().toISOString() },
    phase: 'verifying refreshed cache', verification_message: `Cloudflare accepted the cache refresh for ${state.zone_name}. Checking the same public URLs again.` });
  return true;
}
