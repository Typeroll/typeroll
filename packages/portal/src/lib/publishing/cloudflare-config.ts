// The publisher's Cloudflare OAuth client and the permissions Typeroll asks for.
import { isSecretCryptoConfigured } from '../secret-crypto';
import { ConnectionError } from './connections';

export const CLOUDFLARE_CALLBACK = '/api/orgs/publishing/cloudflare/callback';
export const CLOUDFLARE_MEDIA_SCOPES = ['workers-scripts.read', 'workers-scripts.write'];
export const CLOUDFLARE_BUILD_SCOPES = ['workers-scripts.read', 'workers-scripts.write', 'workers-ci.read', 'workers-ci.write'];
export const CLOUDFLARE_SCOPES = ['account-settings.read', 'page.read', 'page.write', 'workers-r2.read', 'workers-r2.write', 'offline_access'];
export const CLOUDFLARE_OPTIONAL_DNS_SCOPES = ['zone.read', 'cache.purge', 'dns.read', 'dns.write', 'zone-transform-rules.read', 'zone-transform-rules.write'];
/** Scopes a connection cannot work without. Media (R2) belongs to the organization, so other Hosting Groups do not need it. */
export const requiredCloudflareScopes = (groupId: string) => groupId === 'default' ? CLOUDFLARE_SCOPES : CLOUDFLARE_SCOPES.filter(scope => !scope.startsWith('workers-r2.'));

export function cloudflareOAuthConfiguration() {
  const clientId = process.env.TYPEROLL_PUBLISH_CLOUDFLARE_CLIENT_ID;
  const clientSecret = process.env.TYPEROLL_PUBLISH_CLOUDFLARE_CLIENT_SECRET;
  let origin: URL;
  try { origin = new URL(process.env.PORTAL_PUBLIC_URL ?? ''); }
  catch { throw new ConnectionError('The publisher has not configured Cloudflare sign-in yet', 503); }
  if (!clientId || !clientSecret || !isSecretCryptoConfigured() || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/' ||
    (origin.protocol !== 'https:' && !(process.env.NODE_ENV !== 'production' && origin.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(origin.hostname)))) {
    throw new ConnectionError('The publisher has not configured Cloudflare sign-in yet', 503);
  }
  return { clientId, clientSecret, callback: `${origin.origin}${CLOUDFLARE_CALLBACK}` };
}
export function cloudflareSetup() {
  try { cloudflareOAuthConfiguration(); return { available: true }; }
  catch { return { available: false }; }
}
