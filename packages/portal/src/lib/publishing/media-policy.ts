import { usesCustomerPublishing, type Site } from '@typeroll/shared';
import { getConnection } from './connections';

/** Organization ownership remains sticky after a site opts in. */
export async function usesPrivateMedia(orgId: string, site: Pick<Site, 'publishing_mode'>) {
  return usesCustomerPublishing(site) || (await getConnection(orgId, 'cloudflare')).media_ready === true;
}
