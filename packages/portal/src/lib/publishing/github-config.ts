import { isSecretCryptoConfigured } from '../secret-crypto';
import { ConnectionError } from './connections';

export const CALLBACK_PATH = '/api/orgs/publishing/github/callback';
const SLUG = /^[a-z0-9-]+$/;

/** The publisher's GitHub App settings, without the credential-storage requirement. */
export function githubAppConfiguration() {
  const env = process.env;
  const config = {
    appId: env.TYPEROLL_PUBLISH_GITHUB_APP_ID ?? '',
    clientId: env.TYPEROLL_PUBLISH_GITHUB_CLIENT_ID ?? '',
    clientSecret: env.TYPEROLL_PUBLISH_GITHUB_CLIENT_SECRET ?? '',
    privateKey: env.TYPEROLL_PUBLISH_GITHUB_PRIVATE_KEY ?? '',
    slug: env.TYPEROLL_PUBLISH_GITHUB_APP_SLUG ?? '',
    origin: env.PORTAL_PUBLIC_URL ?? '',
  };
  if (!Object.values(config).every(Boolean) || !/^\d+$/.test(config.appId) || !SLUG.test(config.slug)) {
    throw new ConnectionError('The publisher has not configured its GitHub App yet', 503, 'publisher_app_misconfigured');
  }
  let url: URL;
  try { url = new URL(config.origin); } catch { throw new ConnectionError('Invalid publisher callback configuration', 503, 'publisher_app_misconfigured'); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      (url.protocol !== 'https:' && !(process.env.NODE_ENV !== 'production' && url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))) {
    throw new ConnectionError('Invalid publisher callback configuration', 503, 'publisher_app_misconfigured');
  }
  return { ...config, origin: url.origin, callback: `${url.origin}${CALLBACK_PATH}` };
}

/** Everything a connection needs: the App and encrypted storage for grants. */
export function githubConfiguration() {
  const config = githubAppConfiguration();
  if (!isSecretCryptoConfigured()) {
    throw new ConnectionError('The publisher has not configured encrypted credential storage yet', 503, 'encryption_unavailable');
  }
  return config;
}

/** The slug is public (it is part of the App's GitHub URL), so it can be shown even when other settings are missing. */
export function githubAppSlug(): string | null {
  const slug = process.env.TYPEROLL_PUBLISH_GITHUB_APP_SLUG ?? '';
  return SLUG.test(slug) ? slug : null;
}

export function githubSetup() {
  let appConfigured = true;
  try { githubAppConfiguration(); } catch { appConfigured = false; }
  const encryptionAvailable = isSecretCryptoConfigured();
  const slug = githubAppSlug();
  return {
    available: appConfigured && encryptionAvailable,
    app_configured: appConfigured,
    encryption_available: encryptionAvailable,
    app_slug: slug,
    install_url: appConfigured && slug ? `https://github.com/apps/${slug}/installations/new` : null,
  };
}
