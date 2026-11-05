import { getStore } from '../datastore';
import { variantStatus, type StaticObservation } from '../builds/verification';
import { ConnectionError } from './connections';
import { findPublishingZone } from './domain-provider';
import { hostingDns } from './hosting-dns';
import { publicationHostname } from './domain-config';
import type { ProviderClient } from './providers.mjs';

/** Path purges per publication; each is followed by bounded observation. Never zone-wide. */
export const MAX_TARGETED_PURGES = 3;
/** Queue-paced observations after one purge (about a minute with the existing backoff). */
export const OBSERVATIONS_PER_PURGE = 5;

/**
 * Where the stale response comes from, measured with a cache-key variant of
 * the same URL. `upstream_cache`: the deployment is correct but a cache keyed by
 * the public URL above the zone (Cloudflare Pages' own) keeps the old response,
 * so zone purges of any scope cannot remove it. `origin`: the deployment
 * itself still answers the old response. `unknown`: the variant could not be read.
 */
export type CacheLayer = 'upstream_cache' | 'origin' | 'unknown';

export interface CacheRecovery {
  publication_id: string;
  hostname: string;
  route: string;
  zone_id: string;
  zone_name: string;
  dns_account_id: string;
  dns_group_id: string;
  state: 'targeted_purge' | 'failed';
  targeted_attempts: number;
  observations_after_purge?: number;
  layer?: CacheLayer;
  variant_status?: number | null;
  cf_ray?: string | null;
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

/** The cache-key variant request; replaceable in offline tests. */
export const cacheLayerProbe = { status: (url: URL): Promise<number | null> => variantStatus(url, {}) };

async function measureLayer(url: URL, expected: number, actual: number | null): Promise<{ layer: CacheLayer; variant_status: number | null }> {
  const status = await cacheLayerProbe.status(url).catch(() => null);
  if (status === null) return { layer: 'unknown', variant_status: null };
  return { layer: status === expected && status !== actual ? 'upstream_cache' : status === actual ? 'origin' : 'unknown', variant_status: status };
}

function failure(state: CacheRecovery) {
  const where = `https://${state.hostname}${state.route}`;
  const ray = state.cf_ray ? ` Cloudflare ray: ${state.cf_ray}.` : '';
  const message = state.layer === 'upstream_cache'
    ? `Cloudflare still serves the removed file ${where} from a cache above the ${state.zone_name} zone, while the same URL with a fresh cache key returns HTTP ${state.variant_status}: the deployment is correct. Purges of this site's addresses cannot clear that cache, and a zone-wide purge would not either. The build is complete; do not rebuild. Retry verification of this same publication later.${ray}`
    : state.layer === 'origin'
      ? `The deployment itself still answers HTTP ${state.variant_status} at ${where}, also with a fresh cache key, so this is not a cache problem. Check the hosting project's active deployment, then retry verification of this same publication.${ray}`
      : `Cloudflare still serves old content at ${where} after ${state.targeted_attempts} refresh${state.targeted_attempts === 1 ? '' : 'es'} of this site's address. No rebuild or zone-wide purge was started. Retry verification of this same publication later.${ray}`;
  return new ConnectionError(message, 409, 'publication_cache_refresh_failed');
}

/**
 * Called under the publication target lease, only after candidate and marker
 * verification. Purges only this publication's own hostname and path prefix,
 * a bounded number of times, then reports which cache layer is stale.
 */
export async function recoverPublicationCache(org: string, jobPath: string, publication: Publication, origin: string,
  dns?: { provider: ProviderClient; accountId: string; groupId: string } | null) {
  const store = getStore(), job = await store.getDoc<RecoveryJob>(jobPath);
  if (!isCachedStaticMismatch(job?.static_probe, origin)) return;
  const probe = job!.static_probe!, hostname = publicationHostname(new URL(origin).hostname), route = probe.route;
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
  if (samePath && previous.state === 'targeted_purge' && (previous.observations_after_purge ?? 0) < OBSERVATIONS_PER_PURGE) {
    await store.updateDoc(jobPath, { cache_recovery: { ...previous, observations_after_purge: (previous.observations_after_purge ?? 0) + 1 }, phase: 'verifying refreshed cache' });
    return;
  }
  const attempts = sameZone ? previous.targeted_attempts : 0;
  const base: CacheRecovery = {
    publication_id: publication.publication_id, hostname, route, zone_id: zone.id, zone_name: zone.name,
    dns_account_id: dns.accountId, dns_group_id: dns.groupId, state: 'targeted_purge',
    targeted_attempts: attempts, observations_after_purge: 0, cf_ray: probe.cf_ray ?? null, updated_at: new Date().toISOString(),
  };
  if (samePath || attempts >= MAX_TARGETED_PURGES) {
    const state: CacheRecovery = { ...base, state: 'failed', ...await measureLayer(url, probe.expected_status, probe.actual_status) };
    console.info(JSON.stringify({ event: 'publication_cache_recovery_failed', hostname, route, layer: state.layer, variant_status: state.variant_status, cf_ray: state.cf_ray, age: probe.response_headers?.age ?? null, targeted_attempts: attempts }));
    await store.updateDoc(jobPath, { cache_recovery: state });
    throw failure(state);
  }
  // Every cache-key variant of this one path on this site's own hostname; never another host or the zone.
  await dns.provider(`/zones/${zone.id}/purge_cache`, { method: 'POST', body: { prefixes: [hostname + route] } });
  await store.updateDoc(jobPath, { cache_recovery: { ...base, targeted_attempts: attempts + 1 }, phase: 'refreshing cached publication files',
    verification_message: `Refreshing Cloudflare's cache for ${route} on ${hostname}. The same published files will be checked again; no rebuild is needed.` });
}
