import { ConnectionError } from './connections';
import { publicationHostname } from './domain-config';
import { ProviderError } from './providers.mjs';

type Provider = (route: string, options: { method: string; body: unknown }) => Promise<unknown>;

/** Invalidate only this site's host, including removed URLs and cached query variants. */
export async function purgePublicationHost(provider: Provider, zoneId: string, hostname: string): Promise<boolean> {
  const host = publicationHostname(hostname);
  if (!zoneId || !/^[a-zA-Z0-9_-]+$/.test(zoneId)) throw new Error('Invalid publication cache zone');
  try {
    await provider(`/zones/${zoneId}/purge_cache`, { method: 'POST', body: { hosts: [host] } });
    return true;
  } catch (error) {
    if (error instanceof ProviderError && error.status === 429) return false;
    if (error instanceof ProviderError && [401, 403].includes(error.status)) {
      throw new ConnectionError('Cloudflare needs Cache Purge access to remove old pages from this site’s public cache. Open Publishing → Cloudflare account → Reconnect Cloudflare → Sign in to Cloudflare again, approve Cache Purge for the domain’s account, then retry publishing. API tokens need the Zone → Cache Purge permission.', 409, 'publishing_cache_access_required');
    }
    throw error;
  }
}
