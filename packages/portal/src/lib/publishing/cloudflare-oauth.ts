import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { FullSession } from '../access';
import { getStore } from '../datastore';
import { claimAccount, ConnectionError, connectionPath, getConnection, openCredentials, saveConnection, sealCredentials, type Connection } from './connections';
import {
  CLOUDFLARE_BUILD_SCOPES, CLOUDFLARE_CALLBACK, CLOUDFLARE_MEDIA_SCOPES, CLOUDFLARE_OPTIONAL_DNS_SCOPES, CLOUDFLARE_SCOPES, cloudflareOAuthConfiguration,
  cloudflareSetup, requiredCloudflareScopes,
} from './cloudflare-config';
import {
  CLOUDFLARE_CONSENT_TRUST_MS, CLOUDFLARE_SIGN_IN_TTL_MS, cloudflareBlocker, cloudflareBlockerFromError, CloudflareFlowError, cloudflareOrganizationView, composeCloudflareDiagnosis,
  currentCloudflareDiagnosis, recordCloudflareDiagnosis, storedCloudflareDiagnosis, synthesizedCloudflareDiagnosis,
  type CloudflareAccountRef, type CloudflareBlocker, type CloudflareBlockerCode, type CloudflareConnectionDiagnosis, type CloudflareDiagnosisAccount,
} from './cloudflare-diagnosis';
import { getHostingGroup } from './hosting-groups';
import { mapPublicationParts } from './parallel';
import { createProviderClient, ProviderError, type ProviderClient } from './providers.mjs';

export { CLOUDFLARE_BUILD_SCOPES, CLOUDFLARE_CALLBACK, CLOUDFLARE_MEDIA_SCOPES, CLOUDFLARE_OPTIONAL_DNS_SCOPES, CLOUDFLARE_SCOPES, cloudflareOAuthConfiguration, cloudflareSetup, CloudflareFlowError };
export const CLOUDFLARE_COOKIE = 'typeroll_publishing_cloudflare';
const TTL = CLOUDFLARE_SIGN_IN_TTL_MS;
const TOKEN_URL = 'https://dash.cloudflare.com/oauth2/token';
const ACCOUNT_PAGE = 50, ACCOUNT_PAGES = 20;
/** Pages access is checked for every authorized account up to this many; larger sets are checked when one is chosen. */
const PROBE_LIMIT = 20;
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
interface AccountChoice { id: string; name: string; usable?: boolean }
interface Grant {
  hosting_group_id?: string;
  user_id: string; expires_at: number; consumed: boolean; revision: string;
  state_hash: string; browser_hash: string; encrypted_verifier: string | null;
  /** The scopes requested. Cloudflare may omit `scope` from the token response when it granted exactly these (RFC 6749 §5.1). */
  scope?: string;
}
/**
 * One consent's tokens and the accounts it authorized, bound to a Typeroll user, Hosting Group and connection revision.
 * The choice can be made for 10 minutes; Check again may offer it again with the same tokens for an hour after consent.
 */
interface Selection {
  id?: string;
  hosting_group_id?: string;
  user_id: string; expires_at: number; consumed: boolean; revision: string;
  choices: AccountChoice[]; encrypted_tokens: string | null;
  consented_at?: number;
}

/** Fixed Cloudflare Pages permission check. No query options: the official client pages this list by 10, and an unsupported page size must not look like missing access. */
export async function verifyPagesAccess(provider: ProviderClient, accountId: string) {
  const projects = await provider(`/accounts/${accountId}/pages/projects`);
  if (!Array.isArray(projects)) throw new CloudflareFlowError(cloudflareBlocker('provider_unavailable'), 502);
}

const flow = (code: CloudflareBlockerCode, context: Parameters<typeof cloudflareBlocker>[1] = {}, status = 409) => new CloudflareFlowError(cloudflareBlocker(code, context), status);
const PUBLISHER_ERRORS: Record<string, string> = {
  invalid_client: 'Cloudflare rejected the OAuth client ID, secret or token authentication method',
  unauthorized_client: 'the OAuth client may not use this grant type',
  unsupported_grant_type: 'the OAuth client may not use this grant type',
  invalid_request: 'Cloudflare rejected the token request, for example a redirect URI that is not registered',
  invalid_scope: 'the OAuth client may not request every permission Typeroll asks for',
};

/**
 * Exchange an authorization code or refresh token. Only Cloudflare's fixed OAuth error identifiers are interpreted;
 * descriptions and bodies are never shown or stored.
 */
async function exchange(parameters: Record<string, string>, fetchImpl: typeof fetch, options: { previous?: CloudflareOAuthTokens; groupId?: string; requested?: string } = {}): Promise<CloudflareOAuthTokens> {
  const config = cloudflareOAuthConfiguration();
  const refreshing = parameters.grant_type === 'refresh_token';
  const send = (method: 'basic' | 'post') => fetchImpl(TOKEN_URL, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json',
      ...(method === 'basic' ? { Authorization: `Basic ${Buffer.from(`${encodeURIComponent(config.clientId)}:${encodeURIComponent(config.clientSecret)}`).toString('base64')}` } : {}) },
    body: new URLSearchParams(method === 'post' ? { ...parameters, client_id: config.clientId, client_secret: config.clientSecret } : parameters).toString(),
  });
  const read = async (response: Response) => { try { return await response.json(); } catch { return null; } };
  let response: Response, data: any;
  try {
    response = await send('basic');
    data = await read(response);
    // A client registered for client_secret_post rejects HTTP Basic as invalid_client before it reads the code or
    // refresh token, so the same request can be sent once with the credentials in the body.
    if (response.status === 401 && data?.error === 'invalid_client') { response = await send('post'); data = await read(response); }
  } catch { throw flow('provider_unavailable', {}, 502); }
  if (!response.ok) {
    const error = typeof data?.error === 'string' ? data.error : '';
    if (error === 'invalid_grant') throw refreshing ? flow('authorization_revoked') : flow('state_expired');
    if (error in PUBLISHER_ERRORS) throw flow('publisher_oauth_misconfigured', { detail: PUBLISHER_ERRORS[error] }, 503);
    if (response.status === 429) throw flow('rate_limited', {}, 502);
    throw flow('provider_unavailable', {}, 502);
  }
  const refresh = data?.refresh_token ?? options.previous?.refresh_token;
  if (data?.token_type?.toLowerCase() !== 'bearer' || typeof data.access_token !== 'string' || !data.access_token || data.access_token.length > 16384 ||
    !Number.isFinite(data.expires_in) || data.expires_in <= 0 || data.expires_in > 365 * 86400) throw flow('provider_unavailable', {}, 502);
  if (typeof refresh !== 'string' || !refresh || refresh.length > 16384) {
    throw flow('publisher_oauth_misconfigured', { detail: 'Cloudflare issued no refresh token; the OAuth client must allow the refresh_token grant' }, 503);
  }
  const scope = typeof data.scope === 'string' ? data.scope : options.previous?.scope ?? options.requested;
  const granted = (scope ?? '').split(/[\s,]+/).filter(Boolean);
  const missing = requiredCloudflareScopes(options.groupId ?? 'default').filter(required => !granted.includes(required));
  if (missing.length) throw new CloudflareFlowError(cloudflareBlocker('permissions_missing', { permissions: missing }), 403);
  return { access_token: data.access_token, refresh_token: refresh, expires_at: Date.now() + data.expires_in * 1000, scope: granted.join(' ') };
}

export async function startCloudflareConnection(session: FullSession, groupId = 'default', buildAccess = false) {
  const config = cloudflareOAuthConfiguration();
  await getHostingGroup(session.orgId, groupId);
  const connection = await getConnection(session.orgId, 'cloudflare', groupId);
  await getStore().deleteDoc(choicePath(session.orgId));
  const previousScopes = connection.encrypted_credentials ? openCredentials<CloudflareStoredCredentials>(session.orgId, 'cloudflare', connection.encrypted_credentials, groupId).oauth?.scope.split(/\s+/) ?? [] : [];
  const buildScopes = groupId === 'default' ? CLOUDFLARE_BUILD_SCOPES.filter(scope => buildAccess || previousScopes.includes(scope)) : [];
  const scope = [...new Set([...requiredCloudflareScopes(groupId), ...CLOUDFLARE_OPTIONAL_DNS_SCOPES, ...(groupId === 'default' ? CLOUDFLARE_MEDIA_SCOPES : []), ...buildScopes])].join(' ');
  const state = nonce(), browser = nonce(), verifier = nonce();
  const startedAt = Date.now();
  await getStore().setDoc(grantPath(session.orgId), { user_id: session.userId, expires_at: startedAt + TTL,
    consumed: false, hosting_group_id: groupId, revision: connection.revision, state_hash: hash(state), browser_hash: hash(browser),
    encrypted_verifier: sealCredentials(session.orgId, 'cloudflare', { verifier }, groupId), scope } satisfies Grant);
  // The card says that a sign-in is under way, and later that it never came back, instead of showing nothing.
  if (connection.status !== 'connected') {
    await recordCloudflareDiagnosis(session.orgId, composeCloudflareDiagnosis({ groupId, revision: connection.revision, attemptedBy: session.userId, signInStartedAt: startedAt }),
      { userId: session.userId, consentedAt: null });
  }
  const url = new URL('https://dash.cloudflare.com/oauth2/auth');
  url.search = new URLSearchParams({ client_id: config.clientId, redirect_uri: config.callback,
    response_type: 'code', scope, state,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' }).toString();
  return { url: url.toString(), browser, maxAge: TTL / 1000 };
}

// ─── Diagnosis bookkeeping ───────────────────────────────────────────────

interface Attempt {
  groupId: string;
  revision: string;
  connected: boolean;
  accounts: CloudflareDiagnosisAccount[];
  /** Grant that this attempt consumed; a newer sign-in replaces it and wins. */
  stateHash?: string;
  /** When the consent whose tokens are kept for Check again was given. */
  consentedAt?: number | null;
}
type Actor = Pick<FullSession, 'orgId' | 'userId'>;

async function newAttempt(session: Actor, groupId: string): Promise<Attempt> {
  const connection = await getConnection(session.orgId, 'cloudflare', groupId);
  return { groupId, revision: connection.revision, connected: connection.status === 'connected', accounts: [] };
}

async function recordAttempt(session: Actor, attempt: Attempt, input: { blockers?: CloudflareBlocker[]; choose?: boolean; connected?: boolean;
  revision?: string; selectionExpiresAt?: number; organization?: CloudflareConnectionDiagnosis; recheckedAt?: number }): Promise<CloudflareConnectionDiagnosis> {
  const diagnosis = composeCloudflareDiagnosis({ groupId: attempt.groupId, revision: input.revision ?? attempt.revision, attemptedBy: session.userId,
    blockers: input.blockers, accounts: attempt.accounts, choose: input.choose, connected: input.connected ?? attempt.connected, selectionExpiresAt: input.selectionExpiresAt });
  if (attempt.stateHash) {
    // An older callback must not replace what a newer sign-in reports.
    const grant = await getStore().getDoc<Grant>(grantPath(session.orgId));
    if (grant && grant.state_hash !== attempt.stateHash) return diagnosis;
  }
  await recordCloudflareDiagnosis(session.orgId, diagnosis, { userId: session.userId, consentedAt: attempt.consentedAt ?? null,
    ...(input.organization ? { organization: input.organization } : {}), ...(input.recheckedAt ? { recheckedAt: input.recheckedAt } : {}) });
  return { ...diagnosis, recheck_available: Boolean(diagnosis.recheck_available || (attempt.consentedAt && Date.now() - attempt.consentedAt < CLOUDFLARE_CONSENT_TRUST_MS)) };
}

/** A callback that matches no sign-in this person started in this browser. A link to the callback can be opened from any site, so it records nothing. */
function unrecorded(blocker: CloudflareBlocker) {
  const error = new CloudflareFlowError(blocker);
  error.unrecorded = true;
  return error;
}

/** Reasons that concern one account and that Check again can find fixed, with the same consent, once someone changes a role or claim. */
const ACCOUNT_REASONS: CloudflareBlockerCode[] = ['pages_access_denied', 'claimed_by_other_organization'];
const keepsConsent = (blocker: CloudflareBlocker) => blocker.action?.kind === 'retry' || ACCOUNT_REASONS.includes(blocker.code);

/** Record why an attempt stopped and rethrow it as a CloudflareFlowError carrying that diagnosis. */
async function failed(session: Actor, attempt: Attempt, error: unknown, recheckedAt?: number): Promise<never> {
  const flowError = error instanceof CloudflareFlowError ? error
    : new CloudflareFlowError(cloudflareBlockerFromError(error, { retry: attempt.consentedAt ? 'recheck' : 'sign_in' }), error instanceof ConnectionError ? error.status : 502);
  if (!flowError.diagnosis && !flowError.unrecorded) {
    try {
      const blocker = flowError.blocker;
      if (attempt.consentedAt && !keepsConsent(blocker)) {
        // A new consent is needed; the tokens of this one are of no further use.
        await discardSelection(session, attempt.groupId);
        attempt.consentedAt = null;
      }
      const row = blocker.account ? attempt.accounts.find(item => item.id === blocker.account!.id) : undefined;
      if (row) {
        // A reason about one account belongs to that account's row.
        attempt.accounts = attempt.accounts.map(item => item === row ? { ...item, usable: false, blockers: [...item.blockers.filter(other => other.code !== blocker.code), blocker] } : item);
      } else if (blocker.account && ACCOUNT_REASONS.includes(blocker.code)) {
        attempt.accounts = [...attempt.accounts, { ...blocker.account, usable: false, blockers: [blocker] }];
      }
      const expiry = attempt.accounts.length > 1 && attempt.accounts.some(item => item.usable) ? await cloudflareChoiceExpiry(session, attempt.groupId) : null;
      const inRow = Boolean(row) || (ACCOUNT_REASONS.includes(blocker.code) && Boolean(blocker.account));
      flowError.diagnosis = await recordAttempt(session, attempt, { blockers: inRow ? [] : [blocker],
        choose: Boolean(expiry), ...(expiry ? { selectionExpiresAt: expiry } : {}), recheckedAt });
    } catch { /* The flow result is still returned; the card falls back to the connection state. */ }
  }
  throw flowError;
}

/**
 * Distinguish a sign-in that returned to another browser from one that expired, without consuming anything.
 * A state this person never started is not recorded: it proves nothing about their sign-in.
 */
async function expiredOrWrongBrowser(session: Actor, state: string, browser: string) {
  const grant = await getStore().getDoc<Grant>(grantPath(session.orgId));
  if (!grant || grant.user_id !== session.userId || grant.state_hash !== hash(state)) return unrecorded(cloudflareBlocker('state_expired'));
  const pending = !grant.consumed && grant.expires_at > Date.now();
  return new CloudflareFlowError(cloudflareBlocker(pending && grant.browser_hash !== hash(browser) ? 'wrong_browser' : 'state_expired'));
}

/** The Hosting Group of the sign-in this person started with `state`, or Default. */
export async function cloudflareCallbackGroup(session: Actor, state: string): Promise<string> {
  const grant = /^[\w-]{43}$/.test(state) ? await getStore().getDoc<Grant>(grantPath(session.orgId)) : null;
  return grant && grant.user_id === session.userId && grant.state_hash === hash(state) ? grant.hosting_group_id ?? 'default' : 'default';
}

const PUBLISHER_CALLBACK_ERRORS = ['invalid_scope', 'invalid_request', 'unauthorized_client', 'unsupported_response_type', 'invalid_client'];

/**
 * OAuth error parameters Cloudflare appends to the callback, mapped without echoing them. Only the pending sign-in
 * this person started in this browser records the result, once; any other request records nothing and returns null.
 */
export async function recordCloudflareCallbackError(session: Actor, input: { error: string; state: string; browser: string }): Promise<CloudflareConnectionDiagnosis | null> {
  const grant = /^[\w-]{43}$/.test(input.state) && /^[\w-]{43}$/.test(input.browser)
    ? await getStore().compareAndUpdateDoc<Grant>(grantPath(session.orgId),
      current => !current.consumed && current.expires_at > Date.now() && current.user_id === session.userId
        && current.state_hash === hash(input.state) && current.browser_hash === hash(input.browser),
      { consumed: true, encrypted_verifier: null }) : null;
  if (!grant) return null;
  const attempt = await newAttempt(session, grant.hosting_group_id ?? 'default');
  attempt.stateHash = grant.state_hash;
  const blocker = input.error === 'access_denied' ? cloudflareBlocker('oauth_cancelled')
    : PUBLISHER_CALLBACK_ERRORS.includes(input.error) ? cloudflareBlocker('publisher_oauth_misconfigured', { detail: input.error === 'invalid_scope'
      ? 'Cloudflare refused the permissions Typeroll asks for' : 'Cloudflare rejected its sign-in settings' })
    : cloudflareBlocker('provider_unavailable');
  return recordAttempt(session, attempt, { blockers: [blocker] });
}

/** Record a callback failure that happened before the flow could start, such as an unknown Hosting Group. */
export async function recordCloudflareFlowFailure(session: Actor, error: unknown, groupId = 'default'): Promise<CloudflareConnectionDiagnosis | undefined> {
  if (error instanceof CloudflareFlowError && (error.diagnosis || error.unrecorded)) return error.diagnosis;
  try { await failed(session, await newAttempt(session, groupId), error); } catch (flowError) { return (flowError as CloudflareFlowError).diagnosis; }
}

// ─── OAuth callback ──────────────────────────────────────────────────────

export async function finishCloudflareConnection(session: FullSession, input: { state: string; browser: string; code: string }, fetchImpl: typeof fetch = fetch): Promise<'connected' | 'select'> {
  const attempt = await newAttempt(session, await cloudflareCallbackGroup(session, input.state));
  try {
    const config = cloudflareOAuthConfiguration();
    if (!/^[\w-]{43}$/.test(input.state) || !input.code || input.code.length > 4096) throw unrecorded(cloudflareBlocker('state_expired'));
    // Consume before exchanging the code. Single-use even on provider failure.
    const grant = /^[\w-]{43}$/.test(input.browser) ? await getStore().compareAndUpdateDoc<Grant>(grantPath(session.orgId), value => !value.consumed && value.expires_at > Date.now() &&
      value.user_id === session.userId && value.state_hash === hash(input.state) && value.browser_hash === hash(input.browser), { consumed: true, encrypted_verifier: null }) : null;
    if (!grant?.encrypted_verifier) throw await expiredOrWrongBrowser(session, input.state, input.browser);
    attempt.stateHash = grant.state_hash;
    attempt.revision = grant.revision;
    const groupId = attempt.groupId;
    await getHostingGroup(session.orgId, groupId);
    const { verifier } = openCredentials<{ verifier: string }>(session.orgId, 'cloudflare', grant.encrypted_verifier, groupId);
    const tokens = await exchange({ grant_type: 'authorization_code', code: input.code, code_verifier: verifier, redirect_uri: config.callback }, fetchImpl,
      { groupId, requested: grant.scope });
    const current = await getConnection(session.orgId, 'cloudflare', groupId);
    if (current.revision !== grant.revision) throw flow('revision_conflict');
    // Keep this consent for Check again while its accounts are read and verified, so a passing Cloudflare
    // problem does not cost the person another sign-in.
    attempt.consentedAt = Date.now();
    await storeSelection(session, { groupId, revision: grant.revision, tokens, consentedAt: attempt.consentedAt, choices: [], expiresAt: 0 });
    return await evaluateConsent(session, attempt, tokens, current, fetchImpl, { automatic: true });
  } catch (error) { return failed(session, attempt, error); }
}

async function storeSelection(session: Actor, input: { groupId: string; revision: string; tokens: CloudflareOAuthTokens; consentedAt: number; choices: AccountChoice[]; expiresAt: number }) {
  await getStore().setDoc(choicePath(session.orgId), { id: randomUUID(), user_id: session.userId, hosting_group_id: input.groupId, revision: input.revision, consumed: false,
    expires_at: input.expiresAt, choices: input.choices, consented_at: input.consentedAt,
    encrypted_tokens: sealCredentials(session.orgId, 'cloudflare', input.tokens, input.groupId) } satisfies Selection);
}

async function discardSelection(session: Actor, groupId: string) {
  await getStore().compareAndUpdateDoc<Selection>(choicePath(session.orgId), value => value.user_id === session.userId && (value.hosting_group_id ?? 'default') === groupId,
    { encrypted_tokens: null, consumed: true });
}

/** List the accounts one consent authorized, check each, and connect the only one or offer a choice. */
async function evaluateConsent(session: Actor, attempt: Attempt, tokens: CloudflareOAuthTokens, current: Connection, fetchImpl: typeof fetch,
  options: { automatic: boolean; recheckedAt?: number }): Promise<'connected' | 'select'> {
  const provider = createProviderClient('Cloudflare', tokens.access_token, fetchImpl);
  const listed: AccountChoice[] = [];
  for (let page = 1; page <= ACCOUNT_PAGES; page++) {
    let accounts: any;
    try { accounts = await provider(`/accounts?per_page=${ACCOUNT_PAGE}&page=${page}`); }
    catch (error) { throw new CloudflareFlowError(cloudflareBlockerFromError(error, { step: 'accounts', retry: 'recheck' }), 502); }
    if (!Array.isArray(accounts)) throw flow('provider_unavailable', { retry: 'recheck' }, 502);
    for (const account of accounts) {
      if (!/^[a-f0-9]{32}$/.test(account?.id ?? '') || typeof account.name !== 'string') throw flow('provider_unavailable', { retry: 'recheck' }, 502);
      listed.push({ id: account.id, name: account.name.slice(0, 200) });
    }
    if (accounts.length < ACCOUNT_PAGE) break;
    if (page === ACCOUNT_PAGES) throw flow('too_many_accounts', { limit: ACCOUNT_PAGE * ACCOUNT_PAGES });
  }
  if (!listed.length) throw flow('no_eligible_account');
  // A saved connection keeps its account: sites and media already use it.
  const previous: CloudflareAccountRef | undefined = current.cloudflare ? { id: current.cloudflare.account_id, name: current.cloudflare.account_name } : undefined;
  const eligible = previous ? listed.filter(account => account.id === previous.id) : listed;
  if (!eligible.length) throw flow('locked_to_account', { previous, ...(listed.length === 1 ? { account: listed[0] } : {}) });
  attempt.accounts = eligible.length <= PROBE_LIMIT
    ? await mapPublicationParts(eligible, account => probeAccount(session.orgId, provider, account), 4)
    : eligible.map(account => ({ ...account, usable: true, blockers: [] }));
  const usable = attempt.accounts.filter(account => account.usable);
  if (!usable.length) {
    const blocker = attempt.accounts[0].blockers[0];
    const error = new CloudflareFlowError(blocker);
    error.diagnosis = await recordAttempt(session, attempt, { recheckedAt: options.recheckedAt });
    throw error;
  }
  // The consent named exactly one account (or the saved one): connecting it is what the person asked for.
  // Several accounts are never chosen for the person; see selectCloudflareAccount.
  if (options.automatic && eligible.length === 1) {
    await saveAccount(session, usable[0].id, tokens, attempt.revision, fetchImpl, attempt.groupId);
    await discardSelection(session, attempt.groupId);
    attempt.consentedAt = null;
    await recordConnected(session, attempt);
    return 'connected';
  }
  const expiresAt = Math.min(Date.now() + TTL, (attempt.consentedAt ?? Date.now()) + CLOUDFLARE_CONSENT_TRUST_MS);
  await storeSelection(session, { groupId: attempt.groupId, revision: attempt.revision, tokens, consentedAt: attempt.consentedAt ?? Date.now(), expiresAt,
    choices: attempt.accounts.map(({ id, name, usable: ok }) => ({ id, name, usable: ok })) });
  await recordAttempt(session, attempt, { choose: true, selectionExpiresAt: expiresAt, recheckedAt: options.recheckedAt });
  return 'select';
}

async function probeAccount(orgId: string, provider: ProviderClient, account: AccountChoice): Promise<CloudflareDiagnosisAccount> {
  const blockers: CloudflareBlocker[] = [];
  const ref = { id: account.id, name: account.name };
  try { await verifyPagesAccess(provider, account.id); }
  catch (error) { blockers.push(cloudflareBlockerFromError(error, { account: ref, step: 'pages', retry: 'recheck' })); }
  const claim = await getStore().getDoc<{ org_id: string }>(`publishing_account_claims/cloudflare-${account.id}`);
  if (claim && claim.org_id !== orgId) blockers.push(cloudflareBlocker('claimed_by_other_organization', { account: ref }));
  return { ...ref, usable: !blockers.length, blockers };
}

async function recordConnected(session: Actor, attempt: Attempt) {
  const connection = await getConnection(session.orgId, 'cloudflare', attempt.groupId);
  // The person who connected still sees the other accounts they authorized. Everyone else sees only the saved one.
  await recordAttempt(session, { ...attempt, stateHash: undefined, accounts: attempt.accounts.map(item =>
    item.id === connection.cloudflare?.account_id ? { ...item, usable: true, blockers: [] } : item) },
  { connected: true, revision: connection.revision, organization: synthesizedCloudflareDiagnosis(connection, attempt.groupId) });
}

// ─── Account selection and saving ───────────────────────────────────────

/** Accounts the person may choose now: theirs, for this Hosting Group and revision, within 10 minutes. */
export async function cloudflareChoices(session: Actor, groupId = 'default'): Promise<Array<{ id: string; name: string }>> {
  const selection = await getStore().getDoc<Selection>(choicePath(session.orgId));
  if (!selection || (selection.hosting_group_id ?? 'default') !== groupId || selection.consumed || selection.user_id !== session.userId || selection.expires_at <= Date.now() ||
    (await getConnection(session.orgId, 'cloudflare', groupId)).revision !== selection.revision) return [];
  return selection.choices.filter(choice => choice.usable !== false).map(({ id, name }) => ({ id, name }));
}

async function cloudflareChoiceExpiry(session: Actor, groupId: string): Promise<number | null> {
  const selection = await getStore().getDoc<Selection>(choicePath(session.orgId));
  return selection && !selection.consumed && selection.user_id === session.userId && (selection.hosting_group_id ?? 'default') === groupId
    && selection.expires_at > Date.now() ? selection.expires_at : null;
}

export async function selectCloudflareAccount(session: FullSession, accountId: string, fetchImpl: typeof fetch = fetch, groupId = 'default') {
  const attempt = await newAttempt(session, groupId);
  const stored = await storedCloudflareDiagnosis(session.orgId, groupId);
  if (stored?.user_id === session.userId && stored.revision === attempt.revision) attempt.accounts = stored.accounts;
  try {
    const selection = await getStore().compareAndUpdateDoc<Selection>(choicePath(session.orgId), value => !value.consumed && value.expires_at > Date.now() &&
      value.user_id === session.userId && (value.hosting_group_id ?? 'default') === groupId && Boolean(value.encrypted_tokens)
      && value.choices.some(choice => choice.id === accountId && choice.usable !== false), { consumed: true });
    if (!selection?.encrypted_tokens) {
      const peek = await getStore().getDoc<Selection>(choicePath(session.orgId));
      const own = peek && peek.user_id === session.userId && (peek.hosting_group_id ?? 'default') === groupId && !peek.consumed && peek.encrypted_tokens;
      const trusted = Boolean(own && peek!.consented_at && Date.now() - peek!.consented_at < CLOUDFLARE_CONSENT_TRUST_MS);
      attempt.consentedAt = trusted ? peek!.consented_at : null;
      throw flow('account_choice_expired', { retry: trusted ? 'recheck' : 'sign_in' });
    }
    attempt.revision = selection.revision;
    attempt.consentedAt = selection.consented_at ?? null;
    let tokens = openCredentials<CloudflareOAuthTokens>(session.orgId, 'cloudflare', selection.encrypted_tokens, groupId);
    if (tokens.expires_at <= Date.now() + 60_000) tokens = await exchange({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token }, fetchImpl, { previous: tokens, groupId });
    try { await saveAccount(session, accountId, tokens, selection.revision, fetchImpl, groupId); }
    catch (error) {
      const blocker = cloudflareBlockerFromError(error, { account: selection.choices.find(choice => choice.id === accountId), retry: 'recheck' });
      if (ACCOUNT_REASONS.includes(blocker.code)) {
        // A reason that concerns only this account does not use up the choice: the other accounts stay selectable.
        await getStore().compareAndUpdateDoc<Selection>(choicePath(session.orgId), value => value.id === selection.id && value.consumed,
          { consumed: false, encrypted_tokens: sealCredentials(session.orgId, 'cloudflare', tokens, groupId),
            choices: selection.choices.map(choice => choice.id === accountId ? { ...choice, usable: false } : choice) });
        if (!attempt.accounts.some(item => item.id === accountId)) attempt.accounts = selection.choices.map(({ id, name, usable }) => ({ id, name, usable: usable !== false, blockers: [] }));
        attempt.accounts = attempt.accounts.map(item => item.id === accountId ? { ...item, usable: false, blockers: [blocker] } : item);
        const left = attempt.accounts.some(item => item.usable);
        const flowError = new CloudflareFlowError(blocker);
        flowError.diagnosis = await recordAttempt(session, attempt, { choose: left, ...(left ? { selectionExpiresAt: selection.expires_at } : {}) });
        throw flowError;
      }
      throw error;
    }
    await getStore().compareAndUpdateDoc<Selection>(choicePath(session.orgId), value => value.id === selection.id, { encrypted_tokens: null });
    attempt.consentedAt = null;
    await recordConnected(session, attempt);
  } catch (error) { return failed(session, attempt, error); }
}

async function saveAccount(session: Actor, accountId: string, tokens: CloudflareOAuthTokens, revision: string, fetchImpl: typeof fetch, groupId = 'default') {
  const current = await getConnection(session.orgId, 'cloudflare', groupId);
  if (current.revision !== revision) throw flow('revision_conflict');
  const provider = createProviderClient('Cloudflare', tokens.access_token, fetchImpl);
  let account: any;
  try { account = await provider(`/accounts/${accountId}`); }
  catch (error) { throw new CloudflareFlowError(cloudflareBlockerFromError(error, { step: 'account', account: { id: accountId, name: accountId } }), 502); }
  if (account?.id !== accountId || typeof account.name !== 'string') throw flow('provider_unavailable', {}, 502);
  const ref = { id: accountId, name: account.name.slice(0, 200) };
  if (current.cloudflare && current.cloudflare.account_id !== accountId) {
    throw flow('locked_to_account', { account: ref, previous: { id: current.cloudflare.account_id, name: current.cloudflare.account_name } });
  }
  try { await verifyPagesAccess(provider, accountId); }
  catch (error) { throw new CloudflareFlowError(cloudflareBlockerFromError(error, { step: 'pages', account: ref }), 403); }
  const previous = current.encrypted_credentials ? openCredentials<CloudflareStoredCredentials>(session.orgId, 'cloudflare', current.encrypted_credentials, groupId) : {};
  try { await claimAccount(session.orgId, 'cloudflare', accountId); }
  catch (error) { throw new CloudflareFlowError(cloudflareBlockerFromError(error, { account: ref }), 409); }
  await saveConnection(session.orgId, 'cloudflare', revision, { status: 'connected', auth_method: 'oauth', refresh_lease: null,
    media_ready: Boolean(current.media_ready && previous.access_key_id && previous.secret_access_key && current.cloudflare?.bucket && current.cloudflare.public_bucket),
    connected_at: new Date().toISOString(), connected_by: session.userId,
    cloudflare: { ...current.cloudflare, account_id: accountId, account_name: ref.name, bucket: current.cloudflare?.bucket ?? '', endpoint: `https://${accountId}.r2.cloudflarestorage.com` },
    encrypted_credentials: sealCredentials(session.orgId, 'cloudflare', { oauth: tokens,
      ...(previous.access_key_id && previous.secret_access_key ? { access_key_id: previous.access_key_id, secret_access_key: previous.secret_access_key } : {}) }, groupId) }, groupId);
}

// ─── Check again ─────────────────────────────────────────────────────────

const RECHECK_THROTTLE_MS = 5_000;

/**
 * Check again for one Hosting Group, persisting the result. A saved connection is re-verified with its own
 * authorization: renewal, account access, Cloudflare Pages access and granted permissions. Without one, the
 * person's last consent (within an hour) lists and checks its accounts again and offers a new 10-minute choice;
 * it never connects by itself. `person` is false for API keys: they may re-check a saved connection only and
 * receive the organization-level view. Repeated calls within five seconds return the current diagnosis.
 */
export async function recheckCloudflareDiagnosis(actor: Actor, groupId: string, options: { person: boolean }, fetchImpl: typeof fetch = fetch): Promise<CloudflareConnectionDiagnosis> {
  await getHostingGroup(actor.orgId, groupId);
  const viewer = options.person ? { userId: actor.userId } : undefined;
  const now = Date.now();
  const stored = await storedCloudflareDiagnosis(actor.orgId, groupId);
  if (stored?.rechecked_at && now - stored.rechecked_at < RECHECK_THROTTLE_MS) return currentCloudflareDiagnosis(actor.orgId, groupId, viewer);
  if (!cloudflareSetup().available) return currentCloudflareDiagnosis(actor.orgId, groupId, viewer);
  const connection = await getConnection(actor.orgId, 'cloudflare', groupId);
  if (connection.status === 'connected' && connection.cloudflare) {
    const diagnosis = await checkSavedConnection(actor, groupId, connection, fetchImpl);
    await recordCloudflareDiagnosis(actor.orgId, diagnosis, { userId: actor.userId, scope: 'connection', recheckedAt: now });
    return options.person ? diagnosis : cloudflareOrganizationView(diagnosis);
  }
  if (!options.person) return currentCloudflareDiagnosis(actor.orgId, groupId);
  const selection = await getStore().getDoc<Selection>(choicePath(actor.orgId));
  const reusable = selection && !selection.consumed && selection.user_id === actor.userId && (selection.hosting_group_id ?? 'default') === groupId
    && selection.revision === connection.revision && selection.encrypted_tokens && selection.consented_at && now - selection.consented_at < CLOUDFLARE_CONSENT_TRUST_MS;
  if (!reusable) {
    if (selection?.user_id === actor.userId && selection.encrypted_tokens && !(selection.consented_at && now - selection.consented_at < CLOUDFLARE_CONSENT_TRUST_MS)) {
      await discardSelection(actor, groupId);
    }
    return currentCloudflareDiagnosis(actor.orgId, groupId, viewer);
  }
  const attempt: Attempt = { groupId, revision: connection.revision, connected: false, accounts: [], consentedAt: selection.consented_at };
  try {
    let tokens = openCredentials<CloudflareOAuthTokens>(actor.orgId, 'cloudflare', selection.encrypted_tokens!, groupId);
    if (tokens.expires_at <= now + 60_000) {
      tokens = await exchange({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token }, fetchImpl, { previous: tokens, groupId });
      await getStore().compareAndUpdateDoc<Selection>(choicePath(actor.orgId), value => value.id === selection.id, { encrypted_tokens: sealCredentials(actor.orgId, 'cloudflare', tokens, groupId) });
    }
    await evaluateConsent(actor, attempt, tokens, connection, fetchImpl, { automatic: false, recheckedAt: now });
  } catch (error) {
    try { await failed(actor, attempt, error, now); } catch { /* Recorded; the current diagnosis below carries it. */ }
  }
  return currentCloudflareDiagnosis(actor.orgId, groupId, viewer);
}

/** The saved connection, read with its own authorization. */
async function checkSavedConnection(actor: Actor, groupId: string, connection: Connection, fetchImpl: typeof fetch): Promise<CloudflareConnectionDiagnosis> {
  const saved = connection.cloudflare!;
  const account = { id: saved.account_id, name: saved.account_name };
  const row: CloudflareDiagnosisAccount = { ...account, usable: true, blockers: [] };
  const blockers: CloudflareBlocker[] = [];
  try {
    const provider = await cloudflareClient(actor.orgId, fetchImpl, undefined, groupId);
    try {
      const found = await provider(`/accounts/${saved.account_id}`);
      if (found?.id !== saved.account_id) row.blockers.push(cloudflareBlocker('provider_unavailable', { account, retry: 'recheck' }));
    } catch (error) { row.blockers.push(cloudflareBlockerFromError(error, { account, step: 'account', retry: 'recheck' })); }
    if (!row.blockers.length) {
      try { await verifyPagesAccess(provider, saved.account_id); }
      catch (error) { row.blockers.push(cloudflareBlockerFromError(error, { account, step: 'pages', retry: 'recheck' })); }
    }
    const latest = await getConnection(actor.orgId, 'cloudflare', groupId);
    if (latest.auth_method === 'oauth' && latest.encrypted_credentials) {
      const granted = openCredentials<CloudflareStoredCredentials>(actor.orgId, 'cloudflare', latest.encrypted_credentials, groupId).oauth?.scope.split(/\s+/) ?? [];
      const missing = requiredCloudflareScopes(groupId).filter(scope => !granted.includes(scope));
      if (missing.length) row.blockers.push(cloudflareBlocker('permissions_missing', { account, permissions: missing }));
    }
  } catch (error) {
    blockers.push(cloudflareBlockerFromError(error, { account, step: 'token', retry: 'recheck' }));
  }
  row.usable = !row.blockers.length && !blockers.length;
  // Renewing the authorization during the check rotates the revision; the result describes the newest one.
  const revision = (await getConnection(actor.orgId, 'cloudflare', groupId)).revision;
  return composeCloudflareDiagnosis({ groupId, revision, attemptedBy: actor.userId, connected: true, scope: 'connection', blockers, accounts: [row] });
}

// ─── Using a saved connection ────────────────────────────────────────────

/** Refresh leases serialize rotating tokens across instances, without delaying a build worker. */
async function cloudflareAccess(orgId: string, fetchImpl: typeof fetch = fetch, expectedRevision?: string, groupId = 'default') {
  const store = getStore(), path = connectionPath(orgId, 'cloudflare', groupId);
  for (let attempt = 0; attempt < 20; attempt++) {
    const connection = await getConnection(orgId, 'cloudflare', groupId);
    if (expectedRevision && connection.revision !== expectedRevision) throw new ConnectionError('The connection changed. Reload and try again.', 409);
    if (connection.status !== 'connected' || !connection.encrypted_credentials) throw new ConnectionError('Connect Cloudflare before publishing.', 409);
    const credentials = openCredentials<CloudflareStoredCredentials>(orgId, 'cloudflare', connection.encrypted_credentials, groupId);
    const identity = JSON.stringify([connection.cloudflare?.account_id, connection.connected_at, connection.auth_method]);
    if (!credentials.oauth) return { token: credentials.api_token!, revision: connection.revision, identity };
    if (credentials.oauth.expires_at > Date.now() + 60_000) return { token: credentials.oauth.access_token, revision: connection.revision, identity };
    const lease = randomUUID();
    const acquired = await store.compareAndUpdateDoc<Connection>(path, value => value.status === 'connected' && value.revision === connection.revision &&
      value.encrypted_credentials === connection.encrypted_credentials && (!value.refresh_lease || value.refresh_lease.expires_at <= Date.now()),
    { refresh_lease: { id: lease, expires_at: Date.now() + 45_000 } });
    if (!acquired) { await new Promise(resolve => setTimeout(resolve, 250)); continue; }
    try {
      const tokens = await exchange({ grant_type: 'refresh_token', refresh_token: credentials.oauth.refresh_token }, fetchImpl, { previous: credentials.oauth, groupId });
      const revision = randomUUID();
      const saved = await store.compareAndUpdateDoc<Connection>(path, value => value.status === 'connected' && value.revision === connection.revision && value.refresh_lease?.id === lease,
        { encrypted_credentials: sealCredentials(orgId, 'cloudflare', { ...credentials, oauth: tokens }, groupId), refresh_lease: null, revision });
      if (!saved) throw new ConnectionError('Cloudflare connection changed while renewing authorization.', 409);
      return { token: tokens.access_token, revision, identity };
    } finally {
      await store.compareAndUpdateDoc<Connection>(path, value => value.refresh_lease?.id === lease, { refresh_lease: null });
    }
  }
  throw new ConnectionError('Cloudflare authorization is being renewed. Try again shortly.', 503);
}

export async function cloudflareClient(orgId: string, fetchImpl: typeof fetch = fetch, expectedRevision?: string, groupId = 'default') {
  let access = await cloudflareAccess(orgId, fetchImpl, expectedRevision, groupId);
  let provider = createProviderClient('Cloudflare', access.token, fetchImpl);
  const client: ProviderClient = async (route, options) => {
    const attempted = access;
    try { return await provider(route, options); }
    catch (error) {
      if (!(error instanceof ProviderError) || error.status !== 401) throw error;
      // An upload or concurrent request can renew the grant while this client
      // is alive. Retry a definite authentication rejection once, only with a
      // different token from the same saved account and connection session.
      const renewed = await cloudflareAccess(orgId, fetchImpl, undefined, groupId);
      if (renewed.identity !== attempted.identity) throw new ConnectionError('The Cloudflare connection changed. Reload and try again.', 409);
      if (renewed.token === attempted.token) throw error;
      access = renewed; provider = createProviderClient('Cloudflare', renewed.token, fetchImpl);
      return provider(route, options);
    }
  };
  return Object.assign(client, { connectionRevision: access.revision });
}

/** Coordinator-only bridge to the official static uploader. Never exposed to a build runner. */
export async function withCloudflareCredential<T>(orgId: string, groupId: string, work: (token: string) => Promise<T>): Promise<T> {
  const access = await cloudflareAccess(orgId, fetch, undefined, groupId);
  return work(access.token);
}
