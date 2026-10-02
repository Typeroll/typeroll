import { createHash, randomBytes } from 'node:crypto';
import { githubUserGrant, type GithubUserGrant } from './github-user';
import type { FullSession } from '../access';
import { getStore } from '../datastore';
import { createProviderClient, githubAppClient, assertInstallation, ProviderError, type ProviderClient } from './providers.mjs';
import { claimAccount, ConnectionError, getConnection, openCredentials, saveConnection, sealCredentials, type Connection } from './connections';
import { CALLBACK_PATH, githubConfiguration, githubSetup } from './github-config';
import {
  blockerFromError, composeDiagnosis, githubBlocker, GithubFlowError, GITHUB_IDENTITY_TRUST_MS, primaryAction, recordGithubDiagnosis, synthesizedDiagnosis,
  type BlockerContext, type GithubBlocker, type GithubConnectionDiagnosis, type GithubDiagnosisInstallation, type GithubIdentity,
} from './github-diagnosis';

export { CALLBACK_PATH, githubConfiguration, githubSetup, GithubFlowError };
export const GITHUB_COOKIE = 'typeroll_publishing_github';
const TTL_MS = 10 * 60 * 1000;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const nonce = () => randomBytes(32).toString('base64url');

interface Authorization {
  kind?: 'authorize' | 'install';
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

/**
 * Open the App installation page. Installation callbacks are navigation only
 * (a fresh PKCE sign-in proves authority afterwards), so this can start from
 * any diagnosis that asks for an installation. Another admin's sign-in that
 * is still in progress is not replaced.
 */
export async function startGithubInstallation(session: FullSession) {
  const config = githubConfiguration();
  const connection = await getConnection(session.orgId, 'github');
  const previous = await getStore().getDoc<Authorization>(grantPath(session.orgId));
  const replaceable = (grant: Authorization) => grant.user_id === session.userId || grant.consumed || grant.expires_at <= Date.now();
  if (previous && !replaceable(previous)) throw othersSignIn(previous);
  const state = `install_${nonce()}`;
  const browser = nonce();
  const grant = { kind: 'install', state_hash: hash(state), browser_hash: hash(browser), user_id: session.userId,
    expires_at: Date.now() + TTL_MS, consumed: false, owner: '', revision: connection.revision, encrypted_verifier: null } satisfies Authorization;
  if (previous) {
    const changed = await getStore().compareAndUpdateDoc<Authorization>(grantPath(session.orgId),
      current => current.state_hash === previous.state_hash && replaceable(current), grant);
    if (!changed) throw new ConnectionError('The GitHub connection changed. Reload the page and continue.', 409, 'revision_conflict');
  } else if (!await getStore().createDocIfMissing(grantPath(session.orgId), grant)) {
    throw new ConnectionError('The GitHub connection changed. Reload the page and continue.', 409, 'revision_conflict');
  }
  const url = new URL(`https://github.com/apps/${config.slug}/installations/new`);
  url.searchParams.set('state', state);
  return { url: url.toString(), browser, maxAge: TTL_MS / 1000 };
}

function othersSignIn(grant: Authorization) {
  const minutes = Math.max(1, Math.ceil((grant.expires_at - Date.now()) / 60_000));
  return new ConnectionError(`Another publishing admin is connecting GitHub for this organization right now. Try again in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}, or ask them to finish first.`, 409, 'github_sign_in_in_progress');
}

/**
 * Installation callbacks are navigation only. A fresh PKCE exchange proves authority.
 * `setup_action=request` means a member asked the organization's owners to
 * install the App; nothing is installed yet, so the person waits for an owner.
 */
export async function resumeGithubInstallation(session: FullSession, input: { state: string; browser: string; setupAction?: string | null }) {
  const attempt = await newAttempt(session);
  try {
    if (!/^install_[\w-]{43}$/.test(input.state)) throw unrecorded(githubBlocker('state_expired'));
    const revision = (await getConnection(session.orgId, 'github')).revision;
    const grant = /^[\w-]{43}$/.test(input.browser) ? await getStore().compareAndUpdateDoc<Authorization>(grantPath(session.orgId),
      current => current.kind === 'install' && !current.consumed && current.expires_at > Date.now()
        && current.user_id === session.userId && current.revision === revision
        && current.state_hash === hash(input.state) && current.browser_hash === hash(input.browser),
      { consumed: true }) : null;
    if (!grant) throw await expiredOrWrongBrowser(session, input.state, input.browser);
    attempt.stateHash = grant.state_hash;
    if (input.setupAction === 'request') {
      const diagnosis = await recordAttempt(session, attempt, { blockers: [githubBlocker('install_request_pending')] });
      return { owner: grant.owner, waiting: true as const, diagnosis };
    }
    return { owner: grant.owner, waiting: false as const };
  } catch (error) { return failed(session, attempt, error); }
}

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

// ─── Diagnosis bookkeeping ───────────────────────────────────────────────

interface Attempt {
  revision: string;
  connected: boolean;
  githubUser: { id: string; login: string } | null;
  /** Set only when this attempt's OAuth sign-in proved githubUser. */
  identity?: GithubIdentity;
  installations: GithubDiagnosisInstallation[];
  /** Grant that this attempt consumed; a newer sign-in replaces it and wins. */
  stateHash?: string;
}

async function newAttempt(session: FullSession): Promise<Attempt> {
  const connection = await getConnection(session.orgId, 'github');
  return { revision: connection.revision, connected: connection.status === 'connected', githubUser: null, installations: [] };
}

async function recordAttempt(session: FullSession, attempt: Attempt, input: { blockers?: GithubBlocker[]; choose?: boolean; connected?: boolean;
  revision?: string; selectionExpiresAt?: number; organization?: GithubConnectionDiagnosis }): Promise<GithubConnectionDiagnosis> {
  const diagnosis = composeDiagnosis({ revision: input.revision ?? attempt.revision, attemptedBy: session.userId, githubUser: attempt.githubUser,
    blockers: input.blockers, installations: attempt.installations, choose: input.choose, connected: input.connected ?? attempt.connected });
  if (attempt.stateHash) {
    // An older callback must not replace what a newer sign-in reports.
    const grant = await getStore().getDoc<Authorization>(grantPath(session.orgId));
    if (grant && grant.state_hash !== attempt.stateHash) return diagnosis;
  }
  await recordGithubDiagnosis(session.orgId, diagnosis, { userId: session.userId, selectionExpiresAt: input.selectionExpiresAt ?? null,
    ...(attempt.identity ? { identity: attempt.identity } : {}), ...(input.organization ? { organization: input.organization } : {}) });
  return diagnosis;
}

/**
 * A callback that matches no sign-in this person started in this browser. A
 * link to the callback can be opened from any site, so it records nothing.
 */
function unrecorded(blocker: GithubBlocker) {
  const error = new GithubFlowError(blocker);
  error.unrecorded = true;
  return error;
}

/** Record why an attempt stopped and rethrow it as a GithubFlowError carrying that diagnosis. */
async function failed(session: FullSession, attempt: Attempt, error: unknown): Promise<never> {
  const flow = error instanceof GithubFlowError ? error
    : new GithubFlowError(blockerFromError(error, { retry: 'sign_in', user: attempt.githubUser }), error instanceof ConnectionError ? error.status : 502);
  if (!flow.diagnosis && !flow.unrecorded) {
    try { flow.diagnosis = await recordAttempt(session, attempt, { blockers: [flow.blocker] }); }
    catch { /* The flow result is still returned; the card falls back to the connection state. */ }
  }
  throw flow;
}

/**
 * Distinguish a sign-in that returned to another browser from one that expired, without consuming anything.
 * A state this person never started is not recorded: it proves nothing about their sign-in.
 */
async function expiredOrWrongBrowser(session: FullSession, state: string, browser: string) {
  const grant = await getStore().getDoc<Authorization>(grantPath(session.orgId));
  if (!grant || grant.user_id !== session.userId || grant.state_hash !== hash(state)) return unrecorded(githubBlocker('state_expired'));
  const pending = !grant.consumed && grant.expires_at > Date.now();
  return new GithubFlowError(githubBlocker(pending && grant.browser_hash !== hash(browser) ? 'wrong_browser' : 'state_expired'));
}

/**
 * OAuth error parameters GitHub appends to the callback, mapped without echoing
 * them. Only the pending sign-in that this person started in this browser
 * records the result, once; any other request records nothing and returns null.
 */
export async function recordGithubCallbackError(session: FullSession, input: { error: string; state: string; browser: string }): Promise<GithubConnectionDiagnosis | null> {
  const attempt = await newAttempt(session);
  const grant = /^(install_)?[\w-]{43}$/.test(input.state) && /^[\w-]{43}$/.test(input.browser)
    ? await getStore().compareAndUpdateDoc<Authorization>(grantPath(session.orgId),
      current => !current.consumed && current.expires_at > Date.now() && current.user_id === session.userId
        && current.state_hash === hash(input.state) && current.browser_hash === hash(input.browser),
      { consumed: true, encrypted_verifier: null }) : null;
  if (!grant) return null;
  attempt.stateHash = grant.state_hash;
  const code = input.error === 'access_denied' ? 'oauth_cancelled'
    : ['redirect_uri_mismatch', 'application_suspended', 'incorrect_client_credentials'].includes(input.error) ? 'publisher_app_misconfigured'
    : 'github_unavailable';
  return recordAttempt(session, attempt, { blockers: [githubBlocker(code, { detail: code === 'publisher_app_misconfigured' ? 'GitHub rejected its sign-in settings' : undefined })] });
}

/** Record a callback failure that happened before any GitHub call, such as a missing cookie. */
export async function recordGithubFlowFailure(session: FullSession, error: unknown): Promise<GithubConnectionDiagnosis | undefined> {
  if (error instanceof GithubFlowError && error.diagnosis) return error.diagnosis;
  try { await failed(session, await newAttempt(session), error); } catch (flow) { return (flow as GithubFlowError).diagnosis; }
}

// ─── Installation evaluation ─────────────────────────────────────────────

export interface GithubChoice {
  owner: string; installation_id: string; account_id: string; account_type?: 'Organization' | 'User';
  /** Set when connecting this account replaces a previously connected one and needs explicit confirmation. */
  account_change?: { from_account_id: string; from_owner: string };
}
export interface InstallationEvaluation {
  installations: GithubDiagnosisInstallation[];
  choices: GithubChoice[];
  /** Whether any installation is on an account the signed-in GitHub user owns. */
  ownsAny: boolean;
  /** Installations on accounts the signed-in GitHub user was proven to own. */
  owned: string[];
}

const REQUIRED: Array<[string, string[]]> = [['administration', ['write']], ['contents', ['write']]];
const grants = (value: unknown, accepted: string[]) => typeof value === 'string' && (accepted.includes(value) || (accepted.includes('read') && value === 'write'));

/** Suspension, repository selection and permission problems of one installation, in a fixed order. */
export async function installationConfigurationBlockers(installation: any, context: BlockerContext,
  appPermissions: () => Promise<Record<string, string> | null>): Promise<GithubBlocker[]> {
  const blockers: GithubBlocker[] = [];
  if (installation.suspended_at) blockers.push(githubBlocker('installation_suspended', context));
  if (installation.repository_selection !== 'all') blockers.push(githubBlocker('repository_selection_limited', context));
  const missing = REQUIRED.filter(([name, accepted]) => !grants(installation.permissions?.[name], accepted)).map(([name]) => name);
  if (missing.length) {
    const app = await appPermissions();
    const notRequested = Boolean(app) && missing.some(name => !grants(app![name], REQUIRED.find(([key]) => key === name)![1]));
    blockers.push(githubBlocker(app && !notRequested ? 'permissions_update_pending' : 'permissions_missing',
      { ...context, permissions: missing.map(name => `${name[0].toUpperCase()}${name.slice(1)} (write)`), notRequested }));
  }
  return blockers;
}

/**
 * Explain every installation of the publisher App that GitHub showed for this
 * user. Each installation is checked independently: an SSO, permission or
 * transport failure on one never hides or aborts the others, and a rejected
 * installation never changes which usable ones are offered.
 */
export async function evaluateInstallations(input: {
  orgId: string; appId: string; user: { id: string | number; login: string }; current: Connection;
  installations: any[];
  /** Organization membership of the user, or null when GitHub reports none. Throws ProviderError. */
  membership: (installation: any) => Promise<any | null>;
  /** Permissions the publisher App requests, or null when unknown. */
  appPermissions: () => Promise<Record<string, string> | null>;
  personalGrant: 'available' | 'expiring_tokens_disabled' | 'sign_in_required';
  retry: 'sign_in' | 'recheck';
}): Promise<InstallationEvaluation> {
  const result: InstallationEvaluation = { installations: [], choices: [], ownsAny: false, owned: [] };
  const userId = String(input.user.id);
  let requested: Promise<Record<string, string> | null> | undefined;
  const seen = new Set<string>();
  for (const installation of input.installations) {
    if (String(installation?.app_id) !== input.appId || !['Organization', 'User'].includes(installation.account?.type) ||
        !Number.isSafeInteger(installation.account?.id) || !Number.isSafeInteger(installation.id) ||
        typeof installation.account.login !== 'string' || !/^[a-z0-9-]+$/i.test(installation.account.login)) continue;
    const installationId = String(installation.id);
    if (seen.has(installationId)) continue;
    seen.add(installationId);
    const account = { login: installation.account.login as string, type: installation.account.type as 'Organization' | 'User', id: String(installation.account.id) };
    const blockers: GithubBlocker[] = [];
    let owner: boolean | null = null;
    const context = (): BlockerContext => ({ account, installationId, owner: owner === true, user: input.user, retry: input.retry });
    try {
      if (account.type === 'User') {
        owner = account.id === userId && account.login.toLowerCase() === input.user.login.toLowerCase();
        if (!owner) blockers.push(githubBlocker('other_users_personal_account', context()));
      } else if (!grants(installation.permissions?.members, ['read'])) {
        blockers.push(githubBlocker('membership_unverifiable', context()));
      } else {
        const membership = await input.membership(installation);
        owner = membership?.state === 'active' && membership.role === 'admin' && String(membership.user?.id) === userId && String(membership.organization?.id) === account.id;
        if (!owner) blockers.push(githubBlocker('not_org_owner', context()));
      }
    } catch (error) {
      // SSO, rate limits and outages affect only this installation.
      blockers.push(blockerFromError(error, context()));
    }
    // Installation settings and claims by other Typeroll organizations are shown only to a proven owner of the account.
    if (owner) {
      result.ownsAny = true;
      result.owned.push(installationId);
      try {
        blockers.push(...await installationConfigurationBlockers(installation, context(), () => requested ??= input.appPermissions().catch(() => null)));
        const claim = await getStore().getDoc<{ org_id: string }>(`publishing_account_claims/github-${account.id}`);
        if (claim && claim.org_id !== input.orgId) blockers.push(githubBlocker('claimed_by_other_organization', context()));
        if (account.type === 'User' && input.personalGrant === 'expiring_tokens_disabled') blockers.push(githubBlocker('expiring_tokens_disabled', context()));
      } catch (error) { blockers.push(blockerFromError(error, context())); }
    }
    const previous = input.current.github;
    let accountChange: GithubChoice['account_change'];
    if (previous && previous.account_id !== account.id) {
      blockers.push(githubBlocker('locked_to_account', { ...context(), previous: { login: previous.owner, id: previous.account_id,
        type: previous.account_type ?? 'Organization', connected: input.current.status === 'connected' } }));
      if (input.current.status !== 'connected') accountChange = { from_account_id: previous.account_id, from_owner: previous.owner };
    }
    const usable = blockers.length === 0;
    result.installations.push({ installation_id: installationId, account, usable, blockers });
    const choice: GithubChoice = { owner: account.login, installation_id: installationId, account_id: account.id, account_type: account.type };
    if (usable) result.choices.push(choice);
    else if (accountChange && blockers.length === 1) result.choices.push({ ...choice, account_change: accountChange });
  }
  return result;
}

/** Top-level blockers when no installation can be connected right away. */
function unusableBlockers(evaluation: InstallationEvaluation): GithubBlocker[] {
  return evaluation.ownsAny ? [] : [githubBlocker('no_installation')];
}

// ─── OAuth callback ──────────────────────────────────────────────────────

export async function finishGithubConnection(session: FullSession, input: { state: string; browser: string; code: string }, fetchImpl: typeof fetch = fetch) {
  const attempt = await newAttempt(session);
  try {
    const config = githubConfiguration();
    if (!/^[\w-]{43}$/.test(input.state) || !input.code || input.code.length > 1024) throw unrecorded(githubBlocker('state_expired'));
    // Consume before exchanging the code. Single-use even on provider failure.
    const grant = /^[\w-]{43}$/.test(input.browser) ? await getStore().compareAndUpdateDoc<Authorization>(grantPath(session.orgId),
      (value) => !value.consumed && value.expires_at > Date.now() && value.user_id === session.userId &&
        value.state_hash === hash(input.state) && value.browser_hash === hash(input.browser),
      { consumed: true, encrypted_verifier: null }) : null;
    if (!grant?.encrypted_verifier) throw await expiredOrWrongBrowser(session, input.state, input.browser);
    attempt.revision = grant.revision;
    attempt.stateHash = grant.state_hash;
    const { verifier } = openCredentials<{ verifier: string }>(session.orgId, 'github', grant.encrypted_verifier);
    const tokenResponse = await exchangeCode(config, input.code, verifier, fetchImpl);
    // Organization tokens prove owner authority only. Personal tokens also authorize repository creation and are encrypted after verification.
    const userClient = createProviderClient('GitHub', tokenResponse.access_token, fetchImpl);
    const user = await userClient('/user');
    if (!Number.isSafeInteger(user.id) || !/^[a-z0-9-]+$/i.test(user.login)) throw new GithubFlowError(githubBlocker('github_unavailable'), 502);
    attempt.githubUser = { id: String(user.id), login: user.login };
    attempt.identity = { user: attempt.githubUser, verifiedAt: Date.now() };
    const listed: any[] = [];
    for (let page = 1; page <= 20; page++) {
      const result = await userClient(`/user/installations?per_page=100&page=${page}`);
      if (!Array.isArray(result.installations)) throw new GithubFlowError(githubBlocker('github_unavailable'), 502);
      listed.push(...result.installations.filter((item: any) => String(item?.app_id) === config.appId
        && (!grant.owner || item.account?.login?.toLowerCase() === grant.owner.toLowerCase())));
      if (result.installations.length < 100) break;
    }
    if (!listed.length) throw new GithubFlowError(githubBlocker('no_installation'));
    let personal: GithubUserGrant | undefined;
    let personalGrant: 'available' | 'expiring_tokens_disabled' = 'available';
    if (listed.some(item => item.account?.type === 'User')) {
      try { personal = githubUserGrant(tokenResponse, String(user.id)); }
      catch (error) { if (error instanceof ConnectionError && error.code === 'github_expiring_authorization_required') personalGrant = 'expiring_tokens_disabled'; else throw error; }
    }
    const current = await getConnection(session.orgId, 'github');
    const evaluation = await evaluateInstallations({
      orgId: session.orgId, appId: config.appId, user, current, installations: listed, personalGrant, retry: 'sign_in',
      membership: installation => userClient(`/orgs/${encodeURIComponent(installation.account.login)}/memberships/${encodeURIComponent(user.login)}`, { missing: true }),
      appPermissions: async () => (await githubAppClient(config, fetchImpl)('/app'))?.permissions ?? null,
    });
    attempt.installations = evaluation.installations;
    // "Check again" may re-read exactly the accounts GitHub showed this person.
    attempt.identity.accounts = evaluation.installations.map(item => ({ login: item.account.login, type: item.account.type, origin: 'oauth' as const }));
    return await concludeEvaluation(session, attempt, evaluation, grant.revision, fetchImpl, personal);
  } catch (error) { return failed(session, attempt, error); }
}

async function exchangeCode(config: ReturnType<typeof githubConfiguration>, code: string, verifier: string, fetchImpl: typeof fetch) {
  let response: Response, body: any;
  try {
    response = await fetchImpl('https://github.com/login/oauth/access_token', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: config.clientId, client_secret: config.clientSecret,
        code, redirect_uri: config.callback, code_verifier: verifier }),
    });
    body = await response.json();
  } catch { throw new GithubFlowError(githubBlocker('github_unavailable'), 502); }
  if (response.ok && !body?.error && typeof body?.access_token === 'string' && body.access_token) return body;
  // Only GitHub's fixed error identifiers are interpreted; descriptions are never shown.
  if (['bad_verification_code', 'invalid_grant'].includes(body?.error)) throw new GithubFlowError(githubBlocker('state_expired'));
  if (['incorrect_client_credentials', 'redirect_uri_mismatch', 'unverified_user_email', 'application_suspended'].includes(body?.error)) {
    throw new GithubFlowError(githubBlocker('publisher_app_misconfigured', { detail: 'GitHub rejected its sign-in settings' }), 503);
  }
  throw new GithubFlowError(githubBlocker(response.status === 429 ? 'github_rate_limited' : 'github_unavailable'), 502);
}

/** Connect a single usable installation, or keep proven choices for an explicit selection. */
async function concludeEvaluation(session: FullSession, attempt: Attempt, evaluation: InstallationEvaluation, revision: string,
  fetchImpl: typeof fetch, personal?: GithubUserGrant): Promise<'connected' | 'select'> {
  const { choices } = evaluation;
  if (!choices.length) {
    const blockers = unusableBlockers(evaluation);
    const all = [...blockers, ...evaluation.installations.flatMap(item => item.blockers)];
    const error = new GithubFlowError(all.find(blocker => blocker.action === primaryAction(all)) ?? all[0] ?? githubBlocker('no_installation'));
    error.diagnosis = await recordAttempt(session, attempt, { blockers });
    throw error;
  }
  if (choices.length === 1 && !choices[0].account_change) {
    const choice = choices[0];
    await saveGithubChoice(session, choice, revision, fetchImpl, choice.account_type === 'User' ? personal : undefined);
    await recordConnected(session, attempt);
    return 'connected';
  }
  // Store proven choices and an encrypted grant only when a personal account is offered.
  const expiresAt = await storeGithubSelection(session, attempt.identity!, revision, choices,
    personal && choices.some(choice => choice.account_type === 'User') ? sealCredentials(session.orgId, 'github', personal) : null);
  await recordAttempt(session, attempt, { choose: choices.length > 1, selectionExpiresAt: expiresAt });
  return 'select';
}

async function recordConnected(session: FullSession, attempt: Attempt) {
  const connection = await getConnection(session.orgId, 'github');
  // The person who connected still sees the attempt's other installations. Everyone else sees only the saved one.
  await recordAttempt(session, { ...attempt, stateHash: undefined, installations: attempt.installations.map(item =>
    item.installation_id === connection.github?.installation_id ? { ...item, usable: true, blockers: [] } : item) },
  { connected: true, revision: connection.revision, organization: synthesizedDiagnosis(connection) });
}

// ─── Account selection and saving ───────────────────────────────────────

interface GithubSelection {
  user_id: string; github_user: { id: number; login: string }; revision: string;
  /** When OAuth proved github_user. Organization ownership is re-verified for that identity at most an hour later. */
  identity_verified_at: number;
  expires_at: number; consumed: boolean; choices: GithubChoice[]; encrypted_tokens?: string | null;
}
const choicePath = (orgId: string) => `organizations/${orgId}/publishing_authorizations/github_selection`;
export async function githubChoices(session: FullSession): Promise<GithubChoice[]> {
  const selection = await getStore().getDoc<GithubSelection>(choicePath(session.orgId));
  if (!selection || selection.consumed || selection.user_id !== session.userId || selection.expires_at <= Date.now()) return [];
  if ((await getConnection(session.orgId, 'github')).revision !== selection.revision) return [];
  return selection.choices;
}

/**
 * Store proven choices, bound to this Typeroll user, organization and revision. A choice expires after
 * 10 minutes, and never later than an hour after OAuth proved the identity it was made for. Returns the expiry.
 */
export async function storeGithubSelection(session: Pick<FullSession, 'orgId' | 'userId'>, identity: GithubIdentity, revision: string,
  choices: GithubChoice[], encryptedTokens: string | null = null): Promise<number> {
  const expiresAt = Math.min(Date.now() + TTL_MS, identity.verifiedAt + GITHUB_IDENTITY_TRUST_MS);
  await getStore().setDoc(choicePath(session.orgId), { user_id: session.userId, github_user: { id: Number(identity.user.id), login: identity.user.login },
    revision, identity_verified_at: identity.verifiedAt, expires_at: expiresAt, consumed: false, choices, encrypted_tokens: encryptedTokens } satisfies GithubSelection);
  return expiresAt;
}

export async function selectGithubOrganization(session: FullSession, installationId: string, fetchImpl: typeof fetch = fetch,
  options: { confirmAccountChange?: string } = {}) {
  const peek = await getStore().getDoc<GithubSelection>(choicePath(session.orgId));
  const wanted = peek?.user_id === session.userId ? peek.choices?.find(value => value.installation_id === installationId) : undefined;
  // A replacement of a previous account must name that account. A missing confirmation consumes and records nothing.
  if (wanted?.account_change && options.confirmAccountChange !== wanted.account_change.from_account_id) {
    throw new ConnectionError(`Confirm that ${wanted.owner} replaces the previously connected GitHub account ${wanted.account_change.from_owner}.`, 409, 'account_change_confirmation_required');
  }
  const attempt = await newAttempt(session);
  try {
    const selection = await getStore().compareAndUpdateDoc<GithubSelection>(choicePath(session.orgId),
      value => !value.consumed && value.user_id === session.userId && value.expires_at > Date.now()
        && Date.now() - value.identity_verified_at < GITHUB_IDENTITY_TRUST_MS
        && value.choices.some(choice => choice.installation_id === installationId), { consumed: true, encrypted_tokens: null });
    if (!selection) throw new GithubFlowError({ ...githubBlocker('state_expired'), message: 'Your GitHub selection expired. Connect GitHub again or select Check again.' });
    attempt.githubUser = { id: String(selection.github_user.id), login: selection.github_user.login };
    attempt.revision = selection.revision;
    const choice = selection.choices.find(value => value.installation_id === installationId)!;
    const config = githubConfiguration();
    let tokens: GithubUserGrant | undefined;
    if (choice.account_type === 'User') {
      if (choice.account_id !== String(selection.github_user.id) || !selection.encrypted_tokens) throw new GithubFlowError(githubBlocker('other_users_personal_account', { account: { login: choice.owner, type: 'User', id: choice.account_id } }), 403);
      tokens = openCredentials<GithubUserGrant>(session.orgId, 'github', selection.encrypted_tokens);
      if (tokens.expires_at <= Date.now() || tokens.user_id !== choice.account_id) throw new GithubFlowError(githubBlocker('state_expired'));
      const user = await createProviderClient('GitHub', tokens.access_token, fetchImpl)('/user');
      if (String(user.id) !== choice.account_id || user.login?.toLowerCase() !== choice.owner.toLowerCase()) throw new GithubFlowError(githubBlocker('other_users_personal_account', { account: { login: choice.owner, type: 'User', id: choice.account_id } }), 403);
    } else {
      // Ownership is re-verified with App authority: the person's GitHub identity was proven by OAuth, the role is checked now.
      const github = await installationClient(config, choice, fetchImpl);
      const organization = { login: choice.owner, type: 'Organization' as const, id: choice.account_id };
      let membership: any;
      try { membership = await github(`/orgs/${encodeURIComponent(choice.owner)}/memberships/${encodeURIComponent(selection.github_user.login)}`, { missing: true }); }
      catch (error) {
        if (error instanceof ProviderError && error.status === 403 && !error.rateLimited) throw new GithubFlowError(githubBlocker('membership_unverifiable', { account: organization, installationId }), 403);
        throw error;
      }
      if (membership?.state !== 'active' || membership.role !== 'admin' || membership.user?.id !== selection.github_user.id || String(membership.organization?.id) !== choice.account_id) {
        throw new GithubFlowError(githubBlocker('not_org_owner', { account: organization, installationId, user: selection.github_user }), 403);
      }
    }
    await saveGithubChoice(session, choice, selection.revision, fetchImpl, tokens, choice.account_change ? options.confirmAccountChange : undefined);
    await recordConnected(session, attempt);
  } catch (error) { return failed(session, attempt, error); }
}

/** App-authority client for an installation, explaining configuration problems as blockers. */
async function installationClient(config: ReturnType<typeof githubConfiguration>, choice: GithubChoice, fetchImpl: typeof fetch): Promise<ProviderClient> {
  const app = githubAppClient(config, fetchImpl);
  let installation: any;
  try { installation = await app(`/app/installations/${encodeURIComponent(choice.installation_id)}`); }
  catch (error) {
    if ((error as { status?: number }).status === 401) throw new GithubFlowError(githubBlocker('publisher_app_misconfigured', { detail: 'GitHub rejected the App credentials' }), 503);
    throw error;
  }
  const account = { login: choice.owner, type: choice.account_type ?? 'Organization', id: choice.account_id } as const;
  const context = { account, installationId: choice.installation_id, owner: true };
  if (String(installation?.id) !== choice.installation_id || String(installation.app_id) !== config.appId || installation.account?.type !== account.type ||
      String(installation.account?.id) !== account.id || installation.account?.login?.toLowerCase() !== account.login.toLowerCase()) {
    throw new ConnectionError('GitHub account identity changed', 409, 'revision_conflict');
  }
  if (installation.suspended_at) throw new GithubFlowError(githubBlocker('installation_suspended', context));
  if (installation.repository_selection !== 'all') throw new GithubFlowError(githubBlocker('repository_selection_limited', context));
  const missing = REQUIRED.filter(([name, accepted]) => !grants(installation.permissions?.[name], accepted)).map(([name]) => `${name[0].toUpperCase()}${name.slice(1)} (write)`);
  if (missing.length) throw new GithubFlowError(githubBlocker('permissions_missing', { ...context, permissions: missing }));
  // Defense in depth: the shared assertion used by every publishing path.
  assertInstallation(installation, { appId: config.appId, installationId: choice.installation_id, owner: choice.owner, accountId: choice.account_id, accountType: account.type });
  const access = await app(`/app/installations/${encodeURIComponent(choice.installation_id)}/access_tokens`, { method: 'POST', body: {} });
  return createProviderClient('GitHub', access.token, fetchImpl);
}

async function saveGithubChoice(session: FullSession, choice: GithubChoice, revision: string, fetchImpl: typeof fetch, tokens?: GithubUserGrant, confirmedReplacement?: string) {
  const config = githubConfiguration();
  const { owner, installation_id: installationId, account_id: accountId } = choice;
  // Revalidate with app authority before accepting the installation for publishing.
  const github = await installationClient(config, choice, fetchImpl);
  const account = await github(`/${choice.account_type === 'User' ? 'users' : 'orgs'}/${encodeURIComponent(owner)}`);
  if (String(account.id) !== accountId || (choice.account_type === 'User' && (account.type !== 'User' || tokens?.user_id !== accountId))) throw new ConnectionError('GitHub account identity changed', 409, 'revision_conflict');
  const current = await getConnection(session.orgId, 'github');
  const same = current.github?.account_id === accountId && current.github.installation_id === installationId && current.github.app_id === config.appId;
  // Saving the connection that already exists is not a conflict. A personal account's renewed
  // authorization is still saved: it belongs to the same, already connected account.
  if (current.status === 'connected' && same && current.revision !== revision) {
    if (!tokens) return;
    revision = current.revision;
  }
  if (current.github && current.github.account_id !== accountId) {
    // After an explicit disconnect the organization may move to another account once the person confirms which account it replaces.
    const confirmed = current.status === 'disconnected' && confirmedReplacement === current.github.account_id;
    if (!confirmed) {
      throw new GithubFlowError(githubBlocker('locked_to_account', { account: { login: owner, type: choice.account_type ?? 'Organization', id: accountId }, installationId,
        previous: { login: current.github.owner, id: current.github.account_id, type: current.github.account_type ?? 'Organization', connected: current.status === 'connected' } }));
    }
  }
  if (current.revision !== revision) throw new ConnectionError('The connection changed. Reload the page and try again.', 409, 'revision_conflict');
  await claimAccount(session.orgId, 'github', accountId);
  await saveConnection(session.orgId, 'github', revision, {
    status: 'connected', connected_at: new Date().toISOString(), connected_by: session.userId,
    github: { app_id: config.appId, installation_id: installationId, account_id: accountId, owner, ...(choice.account_type === 'User' ? { account_type: 'User' as const } : {}) },
    encrypted_credentials: tokens ? sealCredentials(session.orgId, 'github', tokens) : null, refresh_lease: null, github_authorization_required: false,
  });
}
