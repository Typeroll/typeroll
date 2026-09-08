import { createHash } from 'node:crypto';
import { paths } from '@typeroll/shared';
import { getStore } from '../datastore';

/** Only byte-verified deployments become public runtime origins. A declared domain is insufficient. */
export async function recordPublishingOrigin(orgId: string, siteId: string, origin: string, temporary = false) {
  const url = new URL(origin);
  if (url.protocol !== 'https:' || url.origin !== origin) throw new Error('Invalid publishing origin');
  await getStore().setDoc(`${paths.site(orgId, siteId)}/publishing_origins/${createHash('sha256').update(origin).digest('hex')}`,
    { origin, expires_at: temporary ? Date.now() + 86400000 : null });
}
export async function publishingRuntimeOrigins(orgId: string, siteId: string) {
  return (await getStore().listDocs<{ origin: string; expires_at?: number | null }>(`${paths.site(orgId, siteId)}/publishing_origins`))
    .filter(item => item.expires_at == null || item.expires_at > Date.now()).map(item => item.origin);
}
