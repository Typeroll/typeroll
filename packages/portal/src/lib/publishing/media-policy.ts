import { paths, type Site } from '@typeroll/shared';
import { getStore } from '../datastore';
import { ConnectionError, getConnection } from './connections';
import { getSiteDomains, saveSiteDomains } from './domain-config';

/** Existing managed hosting is migrated only by an explicit site operation. */
export function retainsManagedMedia(site: Pick<Site, 'publishing_mode' | 'hosting_config'>) {
  return site.publishing_mode !== 'customer_git' && Boolean(site.hosting_config?.pages_project);
}

/** Organization ownership remains sticky after a site opts in. */
export async function usesPrivateMedia(orgId: string, site: Pick<Site, 'publishing_mode' | 'hosting_config'>) {
  if (retainsManagedMedia(site)) return false;
  return site.publishing_mode === 'customer_git' || (await getConnection(orgId, 'cloudflare')).media_ready === true;
}

/**
 * Connected media requires the Git build's frozen media manifest. Keep existing
 * hosting and live DNS intact; only the next requested publication changes builder.
 * Called from write operations after organization storage has been verified.
 */
export async function adoptCustomerPublishingForMedia(orgId: string, siteId: string) {
  const store = getStore();
  const path = paths.site(orgId, siteId);
  const site = await store.getDoc<Site>(path);
  if (!site) throw new ConnectionError('Site not found.', 404);
  if (site.publishing_mode === 'customer_git' || retainsManagedMedia(site)) return false;
  const domains = await getSiteDomains(orgId, siteId);
  if (site.domain && !domains.desired.website_host) {
    await saveSiteDomains(orgId, siteId, {
      revision: domains.revision, ...domains.desired, website_host: site.domain, dns_mode: domains.dns_mode,
    });
  }
  const changed = await store.compareAndUpdateDoc<Site>(path,
    current => current.publishing_mode === site.publishing_mode && current.domain === site.domain,
    { publishing_mode: 'customer_git' });
  if (!changed && (await store.getDoc<Site>(path))?.publishing_mode !== 'customer_git') {
    throw new ConnectionError('Site publishing settings changed. Retry with the current settings.', 409, 'publishing_settings_changed');
  }
  return true;
}
