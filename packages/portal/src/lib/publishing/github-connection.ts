import { createHash, randomBytes } from 'node:crypto';
import { githubUserGrant, type GithubUserGrant } from './github-user';
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

export async function startGithubConnection(session: FullSession, owner = '') {
  const config = githubConfiguration();
  if (owner && !/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/i.test(owner)) throw new ConnectionError('Use the organization’s GitHub address name, such as moveria-ab, without spaces. You can also leave it blank and choose after signing in.');
  const connection = await getConnection(session.orgId, 'github');
  await getStore().deleteDoc(choicePath(session.orgId));
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
  let tokenResponse: any;
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
    tokenResponse = body;
  } catch { throw new ConnectionError('GitHub authorization could not be completed. Start again.', 502); }
  // Organization tokens prove owner authority only. Personal tokens also authorize repository creation and are encrypted after verification.
  const userClient = createProviderClient('GitHub', token, fetchImpl);
  const user = await userClient('/user');
  if (!Number.isSafeInteger(user.id) || !/^[a-z0-9-]+$/i.test(user.login)) throw new ConnectionError('GitHub returned an invalid user', 502);
  const installations: any[] = [];
  for (let page = 1; page <= 20; page++) {
    const result = await userClient(`/user/installations?per_page=100&page=${page}`);
    if (!Array.isArray(result.installations)) throw new ConnectionError('GitHub returned invalid installations', 502);
    installations.push(...result.installations.filter((item: any) => String(item.app_id) === config.appId
      && ['Organization', 'User'].includes(item.account?.type)
      && (!grant.owner || item.account.login?.toLowerCase() === grant.owner.toLowerCase())));
    if (result.installations.length < 100) break;
  }
  if (!installations.length) throw new GithubFlowError('install_required', 'Install the Typeroll GitHub App in your personal account or organization, then connect again.');
  const current = await getConnection(session.orgId, 'github');
  const choices: GithubChoice[] = [];
  let invalidPermissions = false;
  for (const installation of installations) {
    const owner = installation.account.login;
    const installationId = String(installation.id);
    try {
      assertInstallation(installation, { appId: config.appId, installationId, owner });
      if (!Number.isSafeInteger(installation.account.id) || (installation.account.type === 'Organization' && installation.permissions?.members !== 'read')) throw new Error();
    } catch { invalidPermissions = true; continue; }
    if (current.github && current.github.account_id !== String(installation.account.id)) continue;
    if (installation.account.type === 'User') {
      if (installation.account.id !== user.id || owner.toLowerCase() !== user.login.toLowerCase()) continue;
    } else {
      const membership = await userClient(`/orgs/${encodeURIComponent(owner)}/memberships/${encodeURIComponent(user.login)}`, { missing: true });
      if (membership?.state !== 'active' || membership.role !== 'admin' || membership.user?.id !== user.id || membership.organization?.id !== installation.account.id) continue;
    }
    choices.push({ owner, installation_id: installationId, account_id: String(installation.account.id), account_type: installation.account.type });
  }
  if (!choices.length) throw new GithubFlowError(invalidPermissions ? 'permissions_required' : 'owner_required',
    invalidPermissions ? 'Approve the requested App permissions and All repositories access, then connect again.' : 'Sign in to your own GitHub account or as an owner of the GitHub organization you want to connect.');
  if (choices.length === 1) {
    await saveGithubChoice(session, choices[0], grant.revision, fetchImpl, choices[0].account_type === 'User' ? githubUserGrant(tokenResponse, String(user.id)) : undefined);
    return 'connected' as const;
  }
  // Store proven choices and an encrypted grant only when a personal account is offered.
  // Selection is bound to this Typeroll user, organization, revision and short expiry.
  await getStore().setDoc(choicePath(session.orgId), { user_id: session.userId, github_user: { id: user.id, login: user.login },
    revision: grant.revision, expires_at: Date.now() + TTL_MS, consumed: false, choices,
    encrypted_tokens: choices.some(choice => choice.account_type === 'User') ? sealCredentials(session.orgId, 'github', githubUserGrant(tokenResponse, String(user.id))) : null });
  return 'select' as const;
}

export class GithubFlowError extends ConnectionError {
  constructor(public code: 'install_required' | 'permissions_required' | 'owner_required', message: string) { super(message); }
}
interface GithubChoice { owner: string; installation_id: string; account_id: string; account_type?: 'Organization' | 'User'; }
interface GithubSelection {
  user_id: string; github_user: { id: number; login: string }; revision: string;
  expires_at: number; consumed: boolean; choices: GithubChoice[]; encrypted_tokens?: string | null;
}
const choicePath = (orgId: string) => `organizations/${orgId}/publishing_authorizations/github_selection`;
export async function githubChoices(session: FullSession): Promise<GithubChoice[]> {
  const selection = await getStore().getDoc<GithubSelection>(choicePath(session.orgId));
  if (!selection || selection.consumed || selection.user_id !== session.userId || selection.expires_at <= Date.now()) return [];
  if ((await getConnection(session.orgId, 'github')).revision !== selection.revision) return [];
  return selection.choices;
}
export async function selectGithubOrganization(session: FullSession, installationId: string, fetchImpl: typeof fetch = fetch) {
  const selection = await getStore().compareAndUpdateDoc<GithubSelection>(choicePath(session.orgId),
    value => !value.consumed && value.user_id === session.userId && value.expires_at > Date.now()
      && value.choices.some(choice => choice.installation_id === installationId), { consumed: true, encrypted_tokens: null });
  if (!selection) throw new ConnectionError('Your GitHub selection expired. Connect GitHub again.');
  const choice = selection.choices.find(value => value.installation_id === installationId)!;
  const config = githubConfiguration();
  const github = await githubInstallationClient({ appId: config.appId, installationId, privateKey: config.privateKey, owner: choice.owner, accountId: choice.account_id, accountType: choice.account_type ?? 'Organization' }, fetchImpl);
  let tokens: GithubUserGrant | undefined;
  if (choice.account_type === 'User') {
    if (choice.account_id !== String(selection.github_user.id) || !selection.encrypted_tokens) throw new ConnectionError('The GitHub account owner must connect the publishing account.', 403);
    tokens = openCredentials<GithubUserGrant>(session.orgId, 'github', selection.encrypted_tokens);
    if (tokens.expires_at <= Date.now() || tokens.user_id !== choice.account_id) throw new ConnectionError('Your GitHub selection expired. Connect GitHub again.');
    const user = await createProviderClient('GitHub', tokens.access_token, fetchImpl)('/user');
    if (String(user.id) !== choice.account_id || user.login?.toLowerCase() !== choice.owner.toLowerCase()) throw new ConnectionError('The GitHub account owner must connect the publishing account.', 403);
  } else {
    const membership = await github(`/orgs/${encodeURIComponent(choice.owner)}/memberships/${encodeURIComponent(selection.github_user.login)}`);
    if (membership?.state !== 'active' || membership.role !== 'admin' || membership.user?.id !== selection.github_user.id || String(membership.organization?.id) !== choice.account_id) {
      throw new ConnectionError('A GitHub organization owner must connect the publishing account', 403);
    }
  }
  await saveGithubChoice(session, choice, selection.revision, fetchImpl, tokens);
}
async function saveGithubChoice(session: FullSession, choice: GithubChoice, revision: string, fetchImpl: typeof fetch, tokens?: GithubUserGrant) {
  const config = githubConfiguration();
  const { owner, installation_id: installationId, account_id: accountId } = choice;
  // Revalidate with app authority before accepting the installation for publishing.
  const github = await githubInstallationClient({ appId: config.appId, installationId,
    privateKey: config.privateKey, owner, accountId, accountType: choice.account_type ?? 'Organization' }, fetchImpl);
  const account = await github(`/${choice.account_type === 'User' ? 'users' : 'orgs'}/${encodeURIComponent(owner)}`);
  if (String(account.id) !== accountId || (choice.account_type === 'User' && (account.type !== 'User' || tokens?.user_id !== accountId))) throw new ConnectionError('GitHub account identity changed', 409);
  const current = await getConnection(session.orgId, 'github');
  if (current.github && current.github.account_id !== accountId) throw new ConnectionError('Reconnect the original GitHub account; account migration is a separate operation', 409);
  if (current.revision !== revision) throw new ConnectionError('The connection changed. Reload the page and try again.', 409);
  await claimAccount(session.orgId, 'github', accountId);
  await saveConnection(session.orgId, 'github', revision, {
    status: 'connected', connected_at: new Date().toISOString(), connected_by: session.userId,
    github: { app_id: config.appId, installation_id: installationId, account_id: accountId, owner, ...(choice.account_type === 'User' ? { account_type: 'User' as const } : {}) },
    encrypted_credentials: tokens ? sealCredentials(session.orgId, 'github', tokens) : null, refresh_lease: null, github_authorization_required: false,
  });
}
