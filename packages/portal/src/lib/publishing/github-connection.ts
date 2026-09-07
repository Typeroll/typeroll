import { createHash, randomBytes } from 'node:crypto';
import type { FullSession } from '../access';
import { getStore } from '../datastore';
import { isSecretCryptoConfigured } from '../secret-crypto';
import { assertInstallation, createProviderClient, githubInstallationClient } from './providers.mjs';
import { claimAccount, ConnectionError, getConnection, openCredentials, saveConnection, sealCredentials } from './connections';

export const GITHUB_COOKIE = 'typeroll_publishing_github';
export const CALLBACK_PATH = '/api/orgs/publishing/github/callback';
const TTL_MS = 10 * 60 * 1000;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const nonce = () => randomBytes(32).toString('base64url');

export function githubConfiguration() {
  const env = process.env;
  const config = {
    appId: env.TYPEROLL_PUBLISH_GITHUB_APP_ID ?? '',
    clientId: env.TYPEROLL_PUBLISH_GITHUB_CLIENT_ID ?? '',
    clientSecret: env.TYPEROLL_PUBLISH_GITHUB_CLIENT_SECRET ?? '',
    privateKey: env.TYPEROLL_PUBLISH_GITHUB_PRIVATE_KEY ?? '',
    slug: env.TYPEROLL_PUBLISH_GITHUB_APP_SLUG ?? '',
    origin: env.PORTAL_PUBLIC_URL ?? '',
  };
  if (!Object.values(config).every(Boolean) || !isSecretCryptoConfigured() ||
      !/^\d+$/.test(config.appId) || !/^[a-z0-9-]+$/.test(config.slug)) {
    throw new ConnectionError('The publisher has not configured its GitHub App yet', 503);
  }
  let url: URL;
  try { url = new URL(config.origin); } catch { throw new ConnectionError('Invalid publisher callback configuration', 503); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      (url.protocol !== 'https:' && !(process.env.NODE_ENV !== 'production' && url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))) {
    throw new ConnectionError('Invalid publisher callback configuration', 503);
  }
  return { ...config, origin: url.origin, callback: `${url.origin}${CALLBACK_PATH}` };
}

export function githubSetup() {
  try {
    const { slug } = githubConfiguration();
    return { available: true, install_url: `https://github.com/apps/${slug}/installations/new` };
  } catch { return { available: false, install_url: null }; }
}

interface Authorization {
  state_hash: string;
  browser_hash: string;
  user_id: string;
  expires_at: number;
  consumed: boolean;
  owner: string;
  revision: string;
  encrypted_verifier: string | null;
}
const grantPath = (orgId: string) => `organizations/${orgId}/publishing_authorizations/github`;

export async function startGithubConnection(session: FullSession, owner: string) {
  const config = githubConfiguration();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/i.test(owner)) throw new ConnectionError('Enter a GitHub organization name');
  const connection = await getConnection(session.orgId, 'github');
  const state = nonce();
  const browser = nonce();
  const verifier = nonce();
  await getStore().setDoc(grantPath(session.orgId), {
    state_hash: hash(state), browser_hash: hash(browser), user_id: session.userId,
    expires_at: Date.now() + TTL_MS, consumed: false, owner,
    revision: connection.revision, encrypted_verifier: sealCredentials(session.orgId, 'github', { verifier }),
  } satisfies Authorization);
  const url = new URL('https://github.com/login/oauth/authorize');
  url.search = new URLSearchParams({ client_id: config.clientId, redirect_uri: config.callback,
    state, code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256', allow_signup: 'false', prompt: 'select_account' }).toString();
  return { url: url.toString(), browser, maxAge: TTL_MS / 1000 };
}

export async function finishGithubConnection(session: FullSession, input: { state: string; browser: string; code: string }, fetchImpl: typeof fetch = fetch) {
  const config = githubConfiguration();
  if (!/^[\w-]{43}$/.test(input.state) || !/^[\w-]{43}$/.test(input.browser) || !input.code || input.code.length > 1024) {
    throw new ConnectionError('GitHub authorization expired or did not match this browser');
  }
  // Consume before exchanging the code. Single-use even on provider failure.
  const grant = await getStore().compareAndUpdateDoc<Authorization>(grantPath(session.orgId),
    (value) => !value.consumed && value.expires_at > Date.now() && value.user_id === session.userId &&
      value.state_hash === hash(input.state) && value.browser_hash === hash(input.browser),
    { consumed: true, encrypted_verifier: null });
  if (!grant?.encrypted_verifier) throw new ConnectionError('GitHub authorization expired or did not match this browser');
  const { verifier } = openCredentials<{ verifier: string }>(session.orgId, 'github', grant.encrypted_verifier);
  let token: string;
  try {
    const response = await fetchImpl('https://github.com/login/oauth/access_token', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: config.clientId, client_secret: config.clientSecret,
        code: input.code, redirect_uri: config.callback, code_verifier: verifier }),
    });
    const body = await response.json();
    if (!response.ok || body.error || typeof body.access_token !== 'string' || !body.access_token) throw new Error();
    token = body.access_token;
  } catch { throw new ConnectionError('GitHub authorization could not be completed. Start again.', 502); }
  // User tokens are used only to prove authority and are never persisted.
  const userClient = createProviderClient('GitHub', token, fetchImpl);
  const user = await userClient('/user');
  if (!Number.isSafeInteger(user.id) || !/^[a-z0-9-]+$/i.test(user.login)) throw new ConnectionError('GitHub returned an invalid user', 502);
  let installation;
  for (let page = 1; page <= 20; page++) {
    const result = await userClient(`/user/installations?per_page=100&page=${page}`);
    if (!Array.isArray(result.installations)) throw new ConnectionError('GitHub returned invalid installations', 502);
    installation = result.installations.find((item: any) => String(item.app_id) === config.appId && item.account?.login?.toLowerCase() === grant.owner.toLowerCase());
    if (installation || result.installations.length < 100) break;
  }
  if (!installation) throw new ConnectionError('Install the publisher GitHub App on this organization first, then connect again');
  const installationId = String(installation.id);
  assertInstallation(installation, { appId: config.appId, installationId, owner: grant.owner });
  if (!Number.isSafeInteger(installation.account.id) || installation.permissions?.members !== 'read') {
    throw new ConnectionError('The GitHub App requires organization Members read permission');
  }
  const membership = await userClient(`/orgs/${encodeURIComponent(grant.owner)}/memberships/${encodeURIComponent(user.login)}`);
  if (membership.state !== 'active' || membership.role !== 'admin' || membership.user?.id !== user.id || membership.organization?.id !== installation.account.id) {
    throw new ConnectionError('A GitHub organization owner must connect the publishing account', 403);
  }
  // Revalidate with app authority before accepting the installation for publishing.
  const github = await githubInstallationClient({ appId: config.appId, installationId,
    privateKey: config.privateKey, owner: grant.owner }, fetchImpl);
  const organization = await github(`/orgs/${encodeURIComponent(grant.owner)}`);
  if (organization.id !== installation.account.id) throw new ConnectionError('GitHub organization identity changed', 409);
  const current = await getConnection(session.orgId, 'github');
  const accountId = String(installation.account.id);
  if (current.github && current.github.account_id !== accountId) throw new ConnectionError('Reconnect the original GitHub organization; account migration is a separate operation', 409);
  await claimAccount(session.orgId, 'github', accountId);
  await saveConnection(session.orgId, 'github', grant.revision, {
    status: 'connected', connected_at: new Date().toISOString(), connected_by: session.userId,
    github: { app_id: config.appId, installation_id: installationId, account_id: accountId, owner: installation.account.login },
  });
}
