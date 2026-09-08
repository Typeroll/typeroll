import { getConnection, ConnectionError } from './connections';
import { cloudflareClient } from './cloudflare-oauth';
import { findPublishingZone } from './domain-provider';

/** DNS may belong to the shared organization account or the site's hosting account. */
export async function hostingDns(orgId: string, groupId: string, hostname: string) {
  for (const id of [...new Set(['default', groupId])]) {
    const connection = await getConnection(orgId, 'cloudflare', id);
    if (connection.status !== 'connected' || !connection.cloudflare) continue;
    const provider = await cloudflareClient(orgId, fetch, undefined, id);
    try {
      await findPublishingZone(provider, connection.cloudflare.account_id, hostname);
      return { provider, accountId: connection.cloudflare.account_id };
    } catch (error) {
      if (error instanceof ConnectionError && error.code === 'domain_zone_required') continue;
      // Missing consent must stay actionable; do not hide an authorization failure.
      throw error;
    }
  }
  throw new ConnectionError('The hostname is not in an active zone accessible through the organization or Hosting Group connection. Connect DNS access in Publishing or select external DNS management.', 409, 'domain_zone_required');
}
