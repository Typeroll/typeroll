// The publisher's Cloudflare OAuth client and the permissions Typeroll asks for.
import { isSecretCryptoConfigured } from '../secret-crypto';
import { ConnectionError } from './connections';

export const CLOUDFLARE_CALLBACK = '/api/orgs/publishing/cloudflare/callback';
export const CLOUDFLARE_MEDIA_SCOPES = ['workers-scripts.read', 'workers-scripts.write'];
export const CLOUDFLARE_BUILD_SCOPES = ['workers-scripts.read', 'workers-scripts.write', 'workers-ci.read', 'workers-ci.write'];
export const CLOUDFLARE_SCOPES = ['account-settings.read', 'page.read', 'page.write', 'workers-r2.read', 'workers-r2.write', 'offline_access'];
/**
 * Analytics app (Cloudflare Web Analytics) in the hosting account. Creating a Web Analytics site needs Account
 * Settings write; reading its reports needs Account Analytics read. Finding a pasted token's site uses
 * `account-settings.read`, which every connection already has. Connecting for publishing never depends on them.
 */
export const CLOUDFLARE_ANALYTICS_PROVISION_SCOPE = 'account-settings.write';
export const CLOUDFLARE_ANALYTICS_READ_SCOPE = 'account-analytics.read';
export const CLOUDFLARE_ANALYTICS_SCOPES = [CLOUDFLARE_ANALYTICS_PROVISION_SCOPE, CLOUDFLARE_ANALYTICS_READ_SCOPE];
/** Single Redirect rules (redirect hosts such as www) are the `http_request_dynamic_redirect` phase: Dynamic URL Redirects. */
export const CLOUDFLARE_REDIRECT_SCOPES = ['dynamic-redirect.read', 'dynamic-redirect.write'];
/**
 * Optional scopes an operator may add to Connect Cloudflare. Cloudflare refuses the whole sign-in (`invalid_scope`)
 * when a scope is not allowed for the OAuth client, so each deployment lists the ones its client allows in
 * TYPEROLL_PUBLISH_CLOUDFLARE_OPTIONAL_SCOPES (space or comma separated). Unset: Connect Cloudflare requests exactly
 * what it did before these existed, and Analytics access is approved per Site as before.
 */
export const CLOUDFLARE_ONBOARDING_OPTIONAL_SCOPES = [...CLOUDFLARE_ANALYTICS_SCOPES, ...CLOUDFLARE_REDIRECT_SCOPES];
export const CLOUDFLARE_OPTIONAL_SCOPES_ENV = 'TYPEROLL_PUBLISH_CLOUDFLARE_OPTIONAL_SCOPES';
/** The optional scopes this deployment requests with every Connect Cloudflare. Unknown values are ignored. */
export function enabledCloudflareOptionalScopes(): string[] {
  const listed = (process.env[CLOUDFLARE_OPTIONAL_SCOPES_ENV] ?? '').split(/[\s,]+/).map(value => value.trim()).filter(Boolean);
  return CLOUDFLARE_ONBOARDING_OPTIONAL_SCOPES.filter(scope => listed.includes(scope));
}
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
