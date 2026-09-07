import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { FullSession } from '../access';
import { getStore } from '../datastore';
import { isSecretCryptoConfigured } from '../secret-crypto';
import { claimAccount, ConnectionError, connectionPath, getConnection, openCredentials, saveConnection, sealCredentials, type Connection } from './connections';
import { createProviderClient } from './providers.mjs';

export const CLOUDFLARE_COOKIE = 'typeroll_publishing_cloudflare';
export const CLOUDFLARE_CALLBACK = '/api/orgs/publishing/cloudflare/callback';
export const CLOUDFLARE_SCOPES = ['account-settings.read', 'page.read', 'page.write', 'workers-r2.read', 'workers-r2.write', 'offline_access'];
const TTL = 10 * 60_000;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const nonce = () => randomBytes(32).toString('base64url');
const grantPath = (org: string) => `organizations/${org}/publishing_authorizations/cloudflare`;
const choicePath = (org: string) => `organizations/${org}/publishing_authorizations/cloudflare_selection`;

export interface CloudflareOAuthTokens {
  access_token: string; refresh_token: string; expires_at: number; scope: string;
}
export interface CloudflareStoredCredentials {
  api_token?: string; oauth?: CloudflareOAuthTokens;
  access_key_id?: string; secret_access_key?: string;
}
interface AccountChoice { id: string; name: string }
interface Grant {
  user_id: string; expires_at: number; consumed: boolean; revision: string;
  state_hash: string; browser_hash: string; encrypted_verifier: string | null;
}
interface Selection {
  user_id: string; expires_at: number; consumed: boolean; revision: string;
  choices: AccountChoice[]; encrypted_tokens: string | null;
}

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

async function exchange(parameters: Record<string, string>, fetchImpl: typeof fetch, previous?: CloudflareOAuthTokens): Promise<CloudflareOAuthTokens> {
  const config = cloudflareOAuthConfiguration();
  try {
    const response = await fetchImpl('https://dash.cloudflare.com/oauth2/token', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`${encodeURIComponent(config.clientId)}:${encodeURIComponent(config.clientSecret)}`).toString('base64')}` },
      body: new URLSearchParams(parameters).toString(),
    });
    if (!response.ok) throw new Error();
    const data = await response.json();
    const scope = data.scope ?? previous?.scope;
    const refresh = data.refresh_token ?? previous?.refresh_token;
    if (data.token_type?.toLowerCase() !== 'bearer' || typeof data.access_token !== 'string' || !data.access_token || data.access_token.length > 16384 ||
      typeof refresh !== 'string' || !refresh || refresh.length > 16384 || !Number.isFinite(data.expires_in) || data.expires_in <= 0 || data.expires_in > 365 * 86400 ||
      typeof scope !== 'string' || !CLOUDFLARE_SCOPES.every(required => scope.split(/\s+/).includes(required))) throw new Error();
    return { access_token: data.access_token, refresh_token: refresh, expires_at: Date.now() + data.expires_in * 1000, scope };
  } catch { throw new ConnectionError('Cloudflare authorization could not be completed. Reconnect and approve all required permissions.', 502); }
}

export async function startCloudflareConnection(session: FullSession) {
  const config = cloudflareOAuthConfiguration();
  const connection = await getConnection(session.orgId, 'cloudflare');
  await getStore().deleteDoc(choicePath(session.orgId));
  const state = nonce(), browser = nonce(), verifier = nonce();
  await getStore().setDoc(grantPath(session.orgId), { user_id: session.userId, expires_at: Date.now() + TTL,
    consumed: false, revision: connection.revision, state_hash: hash(state), browser_hash: hash(browser),
    encrypted_verifier: sealCredentials(session.orgId, 'cloudflare', { verifier }) } satisfies Grant);
  const url = new URL('https://dash.cloudflare.com/oauth2/auth');
  url.search = new URLSearchParams({ client_id: config.clientId, redirect_uri: config.callback,
    response_type: 'code', scope: CLOUDFLARE_SCOPES.join(' '), state,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' }).toString();
  return { url: url.toString(), browser, maxAge: TTL / 1000 };
}

export async function finishCloudflareConnection(session: FullSession, input: { state: string; browser: string; code: string }, fetchImpl: typeof fetch = fetch) {
  const config = cloudflareOAuthConfiguration();
  if (!/^[\w-]{43}$/.test(input.state) || !/^[\w-]{43}$/.test(input.browser) || !input.code || input.code.length > 4096) {
    throw new ConnectionError('Cloudflare authorization expired or did not match this browser');
  }
  const grant = await getStore().compareAndUpdateDoc<Grant>(grantPath(session.orgId), value => !value.consumed && value.expires_at > Date.now() &&
    value.user_id === session.userId && value.state_hash === hash(input.state) && value.browser_hash === hash(input.browser), { consumed: true, encrypted_verifier: null });
  if (!grant?.encrypted_verifier) throw new ConnectionError('Cloudflare authorization expired or did not match this browser');
  const { verifier } = openCredentials<{ verifier: string }>(session.orgId, 'cloudflare', grant.encrypted_verifier);
  const tokens = await exchange({ grant_type: 'authorization_code', code: input.code, code_verifier: verifier, redirect_uri: config.callback }, fetchImpl);
  const provider = createProviderClient('Cloudflare', tokens.access_token, fetchImpl);
  const current = await getConnection(session.orgId, 'cloudflare');
  if (current.revision !== grant.revision) throw new ConnectionError('The connection changed. Connect Cloudflare again.', 409);
  const choices: AccountChoice[] = [];
  for (let page = 1; page <= 20; page++) {
    const accounts = await provider(`/accounts?per_page=50&page=${page}`);
    if (!Array.isArray(accounts)) throw new ConnectionError('Cloudflare returned invalid accounts', 502);
    for (const account of accounts) {
      if (!/^[a-f0-9]{32}$/.test(account.id ?? '') || typeof account.name !== 'string') throw new ConnectionError('Cloudflare returned an invalid account', 502);
      if (!current.cloudflare || current.cloudflare.account_id === account.id) choices.push({ id: account.id, name: account.name.slice(0, 200) });
    }
    if (accounts.length < 50) break;
    if (page === 20) throw new ConnectionError('Too many Cloudflare accounts were authorized. Select fewer accounts and try again.');
  }
  if (!choices.length) throw new ConnectionError('No eligible Cloudflare account was authorized. Reconnect the original account and approve access.');
  if (choices.length === 1) {
    await saveAccount(session, choices[0].id, tokens, grant.revision, fetchImpl);
    return 'connected';
  }
  await getStore().setDoc(choicePath(session.orgId), { user_id: session.userId, revision: grant.revision, consumed: false,
    expires_at: Date.now() + TTL, choices, encrypted_tokens: sealCredentials(session.orgId, 'cloudflare', tokens) } satisfies Selection);
  return 'select';
}

export async function cloudflareChoices(session: FullSession): Promise<AccountChoice[]> {
  const selection = await getStore().getDoc<Selection>(choicePath(session.orgId));
  if (!selection || selection.consumed || selection.user_id !== session.userId || selection.expires_at <= Date.now() ||
    (await getConnection(session.orgId, 'cloudflare')).revision !== selection.revision) return [];
  return selection.choices;
}
export async function selectCloudflareAccount(session: FullSession, accountId: string, fetchImpl: typeof fetch = fetch) {
  const selection = await getStore().compareAndUpdateDoc<Selection>(choicePath(session.orgId), value => !value.consumed && value.expires_at > Date.now() &&
    value.user_id === session.userId && value.choices.some(choice => choice.id === accountId), { consumed: true, encrypted_tokens: null });
  if (!selection?.encrypted_tokens) throw new ConnectionError('Your Cloudflare selection expired. Connect Cloudflare again.');
  await saveAccount(session, accountId, openCredentials<CloudflareOAuthTokens>(session.orgId, 'cloudflare', selection.encrypted_tokens), selection.revision, fetchImpl);
}
async function saveAccount(session: FullSession, accountId: string, tokens: CloudflareOAuthTokens, revision: string, fetchImpl: typeof fetch) {
  const current = await getConnection(session.orgId, 'cloudflare');
  if (current.revision !== revision) throw new ConnectionError('The connection changed. Connect Cloudflare again.', 409);
  if (current.cloudflare && current.cloudflare.account_id !== accountId) throw new ConnectionError('Reconnect the original Cloudflare account; moving media requires a separate migration.', 409);
  const provider = createProviderClient('Cloudflare', tokens.access_token, fetchImpl);
  const account = await provider(`/accounts/${accountId}`);
  if (account.id !== accountId || typeof account.name !== 'string') throw new ConnectionError('Cloudflare account verification failed', 502);
  await provider(`/accounts/${accountId}/pages/projects?per_page=1`);
  const previous = current.encrypted_credentials ? openCredentials<CloudflareStoredCredentials>(session.orgId, 'cloudflare', current.encrypted_credentials) : {};
  await claimAccount(session.orgId, 'cloudflare', accountId);
  await saveConnection(session.orgId, 'cloudflare', revision, { status: 'connected', auth_method: 'oauth', refresh_lease: null,
    media_ready: Boolean(previous.access_key_id && previous.secret_access_key && current.cloudflare?.bucket),
    connected_at: new Date().toISOString(), connected_by: session.userId,
    cloudflare: { ...current.cloudflare, account_id: accountId, account_name: account.name.slice(0, 200), bucket: current.cloudflare?.bucket ?? '', endpoint: `https://${accountId}.r2.cloudflarestorage.com` },
    encrypted_credentials: sealCredentials(session.orgId, 'cloudflare', { oauth: tokens,
      ...(previous.access_key_id && previous.secret_access_key ? { access_key_id: previous.access_key_id, secret_access_key: previous.secret_access_key } : {}) }) });
}

/** Refresh leases serialize rotating tokens across instances, without delaying a build worker. */
export async function cloudflareClient(orgId: string, fetchImpl: typeof fetch = fetch) {
  const store = getStore(), path = connectionPath(orgId, 'cloudflare');
  for (let attempt = 0; attempt < 20; attempt++) {
    const connection = await getConnection(orgId, 'cloudflare');
    if (connection.status !== 'connected' || !connection.encrypted_credentials) throw new ConnectionError('Connect Cloudflare before publishing.', 409);
    const credentials = openCredentials<CloudflareStoredCredentials>(orgId, 'cloudflare', connection.encrypted_credentials);
    if (!credentials.oauth) return createProviderClient('Cloudflare', credentials.api_token!, fetchImpl);
    if (credentials.oauth.expires_at > Date.now() + 60_000) return createProviderClient('Cloudflare', credentials.oauth.access_token, fetchImpl);
    const lease = randomUUID();
    const acquired = await store.compareAndUpdateDoc<Connection>(path, value => value.status === 'connected' && value.revision === connection.revision &&
      value.encrypted_credentials === connection.encrypted_credentials && (!value.refresh_lease || value.refresh_lease.expires_at <= Date.now()),
    { refresh_lease: { id: lease, expires_at: Date.now() + 45_000 } });
    if (!acquired) { await new Promise(resolve => setTimeout(resolve, 250)); continue; }
    try {
      const tokens = await exchange({ grant_type: 'refresh_token', refresh_token: credentials.oauth.refresh_token }, fetchImpl, credentials.oauth);
      const saved = await store.compareAndUpdateDoc<Connection>(path, value => value.status === 'connected' && value.revision === connection.revision && value.refresh_lease?.id === lease,
        { encrypted_credentials: sealCredentials(orgId, 'cloudflare', { ...credentials, oauth: tokens }), refresh_lease: null, revision: randomUUID() });
      if (!saved) throw new ConnectionError('Cloudflare connection changed while renewing authorization.', 409);
      return createProviderClient('Cloudflare', tokens.access_token, fetchImpl);
    } finally {
      await store.compareAndUpdateDoc<Connection>(path, value => value.refresh_lease?.id === lease, { refresh_lease: null });
    }
  }
  throw new ConnectionError('Cloudflare authorization is being renewed. Try again shortly.', 503);
}
