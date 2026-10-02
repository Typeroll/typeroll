// GitHub connection diagnosis: one persisted answer to "why is GitHub not
// connected, and who must do what next?"
//
// Every exit of the browser flow (OAuth callback, installation return,
// account selection and re-check) records this document. It lists every
// installation of the publisher App that GitHub showed, whether it can be
// used, each reason it cannot, who can fix that reason and one action per
// fix. The portal card, the public API and MCP all read the same projection.
//
// It never contains tokens, OAuth codes, PKCE verifiers, state values or
// provider response bodies. Only GitHub logins, numeric ids, links to
// github.com and fixed messages are stored.

import { getStore } from '../datastore';
import { ConnectionError, getConnection, type Connection } from './connections';
import { githubAppSlug, githubSetup } from './github-config';
import { ProviderError, ProviderTransportError } from './providers.mjs';

export const GITHUB_DIAGNOSIS_VERSION = 1;
const DIAGNOSIS_TTL_MS = 24 * 60 * 60 * 1000;
/** A GitHub identity proven by OAuth may be reused by "Check again" for this long. */
export const GITHUB_IDENTITY_TRUST_MS = 60 * 60 * 1000;
export const GITHUB_TROUBLESHOOTING_URL = 'https://typeroll.com/docs/guides/github-troubleshooting/';

export type GithubDiagnosisOutcome = 'unavailable' | 'sign_in_required' | 'action_required' | 'waiting_on_owner'
  | 'choose' | 'connected' | 'needs_attention' | 'retryable_error';
export type GithubBlockerWho = 'you' | 'github_owner' | 'publisher' | 'typeroll_admin';
export type GithubBlockerCode =
  | 'not_org_owner' | 'membership_unverifiable' | 'sso_authorization_required' | 'repository_selection_limited'
  | 'permissions_update_pending' | 'permissions_missing' | 'installation_suspended' | 'other_users_personal_account'
  | 'locked_to_account' | 'claimed_by_other_organization' | 'no_installation' | 'install_request_pending'
  | 'oauth_cancelled' | 'state_expired' | 'session_expired' | 'wrong_browser' | 'github_unavailable'
  | 'github_rate_limited' | 'revision_conflict' | 'expiring_tokens_disabled' | 'publisher_app_misconfigured'
  | 'encryption_unavailable';
export const GITHUB_BLOCKER_CODES: readonly GithubBlockerCode[] = [
  'not_org_owner', 'membership_unverifiable', 'sso_authorization_required', 'repository_selection_limited',
  'permissions_update_pending', 'permissions_missing', 'installation_suspended', 'other_users_personal_account',
  'locked_to_account', 'claimed_by_other_organization', 'no_installation', 'install_request_pending',
  'oauth_cancelled', 'state_expired', 'session_expired', 'wrong_browser', 'github_unavailable',
  'github_rate_limited', 'revision_conflict', 'expiring_tokens_disabled', 'publisher_app_misconfigured',
  'encryption_unavailable',
];

export interface GithubDiagnosisAction {
  /**
   * link — open url (github.com or documentation) in a new tab.
   * sign_in / switch_account — start GitHub sign-in (account picker shown).
   * install — start the App installation on GitHub.
   * retry — check again without signing in, or sign in again when the proven identity expired.
   * confirm_account_change — connect this account instead of the previous one, after confirmation.
   * contact_publisher — the operator of this Typeroll installation must act; url explains what.
   */
  kind: 'link' | 'sign_in' | 'switch_account' | 'retry' | 'install' | 'contact_publisher' | 'confirm_account_change';
  label: string;
  url?: string;
  installation_id?: string;
}
export interface GithubBlocker {
  code: GithubBlockerCode;
  who: GithubBlockerWho;
  message: string;
  action?: GithubDiagnosisAction;
  retry_after?: number;
  previous_account?: { login: string; id: string; type: 'Organization' | 'User' };
}
export interface GithubDiagnosisInstallation {
  installation_id: string;
  account: { login: string; type: 'Organization' | 'User'; id: string };
  usable: boolean;
  blockers: GithubBlocker[];
}
export interface GithubConnectionDiagnosis {
  version: typeof GITHUB_DIAGNOSIS_VERSION;
  checked_at: string;
  /** Connection revision this diagnosis describes. A newer revision makes it stale. */
  revision: string;
  /** Typeroll user (or `api-key:<prefix>`) whose attempt or check produced it. */
  attempted_by: string | null;
  github_user: { id: string; login: string } | null;
  outcome: GithubDiagnosisOutcome;
  primary_action: GithubDiagnosisAction | null;
  blockers: GithubBlocker[];
  installations: GithubDiagnosisInstallation[];
  app: { slug: string | null; install_url: string | null };
}
type DiagnosisScope = 'attempt' | 'connection';
/**
 * An account whose installation "Check again" may re-read for the proven identity: one GitHub showed
 * at sign-in (oauth), or one the person named later and proved they own (owned).
 */
export interface GithubCheckedAccount { login: string; type: 'Organization' | 'User'; origin: 'oauth' | 'owned' }
/** A GitHub identity that OAuth proved for a Typeroll user. Never taken from a request or an App-only check. */
export interface GithubIdentity { user: { id: string; login: string }; verifiedAt: number; accounts?: GithubCheckedAccount[] }
export interface StoredDiagnosis extends GithubConnectionDiagnosis {
  user_id: string | null;
  expires_at: number;
  /** attempt: one person's sign-in, choice or check, shown only to them. connection: a check of the saved installation. */
  scope: DiagnosisScope;
  /** The GitHub user OAuth last proved for user_id, and when. Kept while the same person records results that prove none. */
  verified_user: { id: string; login: string } | null;
  identity_verified_at: number | null;
  accounts: GithubCheckedAccount[];
  /** Until when the account choice this diagnosis offers can be selected. */
  selection_expires_at: number | null;
  /** The organization-level state every publishing admin and organization API key may see. */
  organization: GithubConnectionDiagnosis | null;
  sequence: number;
  rechecked_at: number | null;
}

export class GithubFlowError extends ConnectionError {
  diagnosis?: GithubConnectionDiagnosis;
  /** The request matched no flow this person started, so nothing was recorded. */
  unrecorded?: boolean;
  constructor(public blocker: GithubBlocker, status = 409) { super(blocker.message, status, blocker.code); }
}

export interface BlockerContext {
  account?: { login: string; type: 'Organization' | 'User'; id: string };
  installationId?: string;
  /** The signed-in GitHub user owns `account` (personal owner or organization owner). */
  owner?: boolean;
  /** The account was named by the person; whether the App is installed there is not revealed. */
  unverified?: boolean;
  user?: { login: string } | null;
  ssoUrl?: string | null;
  retryAfter?: number | null;
  previous?: { login: string; id: string; type: 'Organization' | 'User'; connected: boolean };
  permissions?: string[];
  /** How a retry happens: through a fresh sign-in or a re-check that consumes nothing. */
  retry?: 'sign_in' | 'recheck';
  /** The App itself does not request a required permission, so no owner can grant it. */
  notRequested?: boolean;
  detail?: string;
}

const accountName = (account?: BlockerContext['account']) => account ? (account.type === 'User' ? `@${account.login}` : account.login) : 'this account';
export function installationSettingsUrl(account: { login: string; type: string }, installationId: string) {
  return account.type === 'User' ? `https://github.com/settings/installations/${encodeURIComponent(installationId)}`
    : `https://github.com/organizations/${encodeURIComponent(account.login)}/settings/installations/${encodeURIComponent(installationId)}`;
}
const portalHost = () => { try { return new URL(process.env.PORTAL_PUBLIC_URL ?? '').host; } catch { return ''; } };
const help = (code: GithubBlockerCode) => `${GITHUB_TROUBLESHOOTING_URL}#${code}`;
const installUrl = () => { const slug = githubAppSlug(); return slug ? `https://github.com/apps/${slug}/installations/new` : undefined; };
const appName = () => { const slug = githubAppSlug(); return slug ? `the ${slug} GitHub App` : 'the publisher’s GitHub App'; };
const AppName = () => { const name = appName(); return `${name[0].toUpperCase()}${name.slice(1)}`; };
const retryAction = (context: BlockerContext, label = 'Try again'): GithubDiagnosisAction =>
  context.retry === 'recheck' ? { kind: 'retry', label } : { kind: 'sign_in', label };

/** Fixed, user-facing explanation and fix for each blocker. No provider text is included. */
export function githubBlocker(code: GithubBlockerCode, context: BlockerContext = {}): GithubBlocker {
  const name = accountName(context.account);
  const settings = context.account && context.installationId ? installationSettingsUrl(context.account, context.installationId) : undefined;
  const fixer: GithubBlockerWho = context.owner ? 'you' : 'github_owner';
  const ownerText = context.owner ? 'You can' : context.account?.type === 'User' ? `Only ${name} can` : `An owner of ${name} must`;
  const make = (who: GithubBlockerWho, message: string, action?: GithubDiagnosisAction, extra: Partial<GithubBlocker> = {}): GithubBlocker =>
    plain({ code, who, message, ...(action ? { action } : {}), ...extra });
  const permissionList = (context.permissions ?? []).join(', ') || 'the requested permissions';
  switch (code) {
    case 'not_org_owner':
      if (context.unverified) {
        return make('github_owner', `Typeroll could not confirm that ${context.user ? `@${context.user.login}` : 'your GitHub account'} owns ${name}. Either the App is not installed on ${name} or you are not an owner of it. If you own ${name}, install the App there with All repositories access and Members (read) permission, then select Check again. Otherwise ask an owner of ${name} to select Connect GitHub here.`,
          context.account ? { kind: 'link', label: `See who owns ${name}`, url: `https://github.com/orgs/${encodeURIComponent(context.account.login)}/people?query=role%3Aowner` } : undefined);
      }
      return make('github_owner', `${context.user ? `@${context.user.login}` : 'Your GitHub account'} is not an owner of ${name}. Only an organization owner can connect it to Typeroll. Ask an owner of ${name} to select Connect GitHub here, or connect your personal account or an organization you own.`,
        context.account ? { kind: 'link', label: `See who owns ${name}`, url: `https://github.com/orgs/${encodeURIComponent(context.account.login)}/people?query=role%3Aowner` } : undefined);
    case 'membership_unverifiable':
      return make('github_owner', `GitHub did not confirm whether you own ${name}, because the App installation there has not been granted Members (read) access. An owner of ${name} must approve that permission, then select Check again.`,
        settings ? { kind: 'link', label: `Open ${name} installation settings`, url: `${settings}/permissions/update` } : undefined);
    case 'sso_authorization_required':
      return make('you', `${name} requires SAML single sign-on. Authorize your GitHub session for ${name}, then select Check again.`,
        { kind: 'link', label: `Authorize single sign-on for ${name}`, url: context.ssoUrl ?? (context.account ? `https://github.com/orgs/${encodeURIComponent(context.account.login)}/sso` : undefined) });
    case 'repository_selection_limited':
      return make(fixer, `The App can only access selected repositories in ${name}. Typeroll creates a new repository for each site, so ${ownerText.toLowerCase()} change repository access to All repositories.`,
        settings ? { kind: 'link', label: `Allow all repositories in ${name}`, url: settings } : undefined);
    case 'permissions_update_pending':
      return make(fixer, `The App installation on ${name} has not approved the requested permissions (${permissionList}). ${ownerText} review and accept the request on GitHub.`,
        settings ? { kind: 'link', label: `Review permissions for ${name}`, url: `${settings}/permissions/update` } : undefined);
    case 'permissions_missing':
      if (context.notRequested) {
        return make('publisher', `${AppName()} does not request permissions Typeroll needs (${permissionList}). The operator of this Typeroll installation must add them to the App. Then ${ownerText.toLowerCase()} accept the update.`,
          { kind: 'contact_publisher', label: 'What the publisher must change', url: help(code) });
      }
      return make(fixer, `The App installation on ${name} is missing required permissions (${permissionList}). ${ownerText} accept them in the installation settings. If GitHub shows nothing to accept, the publisher must request them in its App.`,
        settings ? { kind: 'link', label: `Review permissions for ${name}`, url: `${settings}/permissions/update` } : undefined);
    case 'installation_suspended':
      return make(fixer, `The App installation on ${name} is suspended. ${ownerText} unsuspend it in the installation settings.`,
        settings ? { kind: 'link', label: `Open ${name} installation settings`, url: settings } : undefined);
    case 'other_users_personal_account':
      return make('you', `${name} is another person’s personal account. Only ${name} can connect it. Sign in as ${name}, or connect your own account or an organization you own.`,
        { kind: 'switch_account', label: 'Use a different GitHub account' });
    case 'locked_to_account': {
      const previous = context.previous;
      const previousName = previous ? accountName(previous) : 'another account';
      const previousAccount = previous ? { previous_account: { login: previous.login, id: previous.id, type: previous.type } } : {};
      return previous?.connected
        ? make('you', `This organization is connected to ${previousName}. Disconnect ${previousName} first if you want to publish new sites with ${name}.`, undefined, previousAccount)
        : make('you', `This organization previously published with ${previousName}. You can connect ${name} instead after confirming. Existing repositories stay in ${previousName} and are not moved.`,
          { kind: 'confirm_account_change', label: `Use ${name} instead of ${previousName}`, ...(context.installationId ? { installation_id: context.installationId } : {}) }, previousAccount);
    }
    case 'claimed_by_other_organization':
      return make('typeroll_admin', `${name} is already connected to another Typeroll organization. Disconnect it there, or ask your Typeroll administrator to transfer it.`,
        { kind: 'link', label: 'How account transfers work', url: help(code) });
    case 'no_installation':
      return make('you', `${AppName()} is not installed on your personal account or on an organization you own. Install it with All repositories access.`,
        { kind: 'install', label: 'Install the GitHub App', ...(installUrl() ? { url: installUrl() } : {}) });
    case 'install_request_pending':
      return make('github_owner', `Your request to install ${appName()} was sent to the organization’s owners. An owner must approve it on GitHub. Then select Check again.`,
        { kind: 'retry', label: 'Check again' });
    case 'oauth_cancelled':
      return make('you', 'GitHub sign-in was cancelled, so nothing was connected. Sign in again and select Authorize.', { kind: 'sign_in', label: 'Sign in to GitHub' });
    case 'state_expired':
      return make('you', 'This GitHub sign-in expired or was already used. Sign-ins are valid once, for 10 minutes, in the tab and organization that started them. Start again.', { kind: 'sign_in', label: 'Sign in to GitHub again' });
    case 'session_expired':
      return make('you', 'Your Typeroll session ended while you were on GitHub. Sign in to Typeroll, then connect GitHub again.', { kind: 'sign_in', label: 'Sign in to GitHub again' });
    case 'wrong_browser':
      return make('you', `GitHub returned to a different browser, profile or address than the one that started sign-in. Start again in this browser${portalHost() ? ` at ${portalHost()}` : ''}.`,
        { kind: 'sign_in', label: 'Sign in to GitHub again' });
    case 'github_unavailable':
      return make('you', 'GitHub did not respond as expected. Nothing was changed. Try again in a moment.', retryAction(context), context.retryAfter ? { retry_after: context.retryAfter } : {});
    case 'github_rate_limited': {
      const seconds = context.retryAfter ?? 60;
      return make('you', `GitHub is limiting requests right now. Nothing was changed. Try again in ${seconds < 120 ? `${seconds} seconds` : `${Math.ceil(seconds / 60)} minutes`}.`, retryAction(context), { retry_after: seconds });
    }
    case 'revision_conflict':
      return make('you', 'The GitHub connection changed in another tab or session. Nothing was overwritten. Review the current state and try again.', retryAction(context, 'Check again'));
    case 'expiring_tokens_disabled':
      return make('publisher', `Personal accounts need expiring user authorization, which ${appName()} does not use yet. The publisher must enable “Expire user authorization tokens” in the App settings. You can connect an organization you own instead.`,
        { kind: 'contact_publisher', label: 'What the publisher must change', url: help(code) });
    case 'publisher_app_misconfigured':
      return make('publisher', `${AppName()} is not configured correctly${context.detail ? ` (${context.detail})` : ''}. The operator of this Typeroll installation must fix it. Nothing on your GitHub account needs to change.`,
        { kind: 'contact_publisher', label: 'What the publisher must change', url: help(code) });
    case 'encryption_unavailable':
      return make('publisher', `The publisher has not configured encrypted credential storage, so GitHub cannot be connected yet${githubAppSlug() ? ` (App: ${githubAppSlug()})` : ''}. The operator of this Typeroll installation must set it up.`,
        { kind: 'contact_publisher', label: 'What the publisher must change', url: help(code) });
  }
}

const CONNECTED: GithubDiagnosisOutcome[] = ['connected', 'needs_attention'];
const CONNECT: GithubDiagnosisAction = { kind: 'sign_in', label: 'Connect GitHub' };
const FLOW_SIGN_IN: GithubBlockerCode[] = ['oauth_cancelled', 'state_expired', 'session_expired', 'wrong_browser'];
const FLOW_RETRY: GithubBlockerCode[] = ['github_unavailable', 'github_rate_limited', 'revision_conflict'];
const PUBLISHER: GithubBlockerCode[] = ['publisher_app_misconfigured', 'encryption_unavailable'];
/** Order in which a blocker's action becomes the card's one primary button. */
const PRECEDENCE: GithubBlockerCode[] = [
  'encryption_unavailable', 'publisher_app_misconfigured', 'session_expired', 'wrong_browser', 'state_expired', 'oauth_cancelled',
  'revision_conflict', 'github_rate_limited', 'github_unavailable', 'sso_authorization_required', 'locked_to_account',
  'permissions_update_pending', 'permissions_missing', 'repository_selection_limited', 'installation_suspended',
  'membership_unverifiable', 'install_request_pending', 'no_installation', 'other_users_personal_account',
  'expiring_tokens_disabled', 'not_org_owner', 'claimed_by_other_organization',
];

export function primaryAction(blockers: GithubBlocker[]): GithubDiagnosisAction | null {
  const ranked = blockers.filter(blocker => blocker.action)
    .sort((a, b) => Number(b.who === 'you') - Number(a.who === 'you') || PRECEDENCE.indexOf(a.code) - PRECEDENCE.indexOf(b.code));
  return ranked[0]?.action ?? null;
}

export function composeDiagnosis(input: {
  revision: string; attemptedBy: string | null; githubUser?: { id: string | number; login: string } | null;
  blockers?: GithubBlocker[]; installations?: GithubDiagnosisInstallation[]; connected?: boolean; choose?: boolean;
  /** attempt (default): one person's sign-in or choice. connection: a check of the saved installation. */
  scope?: DiagnosisScope;
}): GithubConnectionDiagnosis {
  const blockers = input.blockers ?? [], installations = input.installations ?? [];
  const has = (codes: GithubBlockerCode[]) => blockers.some(blocker => codes.includes(blocker.code));
  const installationBlockers = installations.flatMap(installation => installation.blockers);
  const outcome: GithubDiagnosisOutcome = has(PUBLISHER) ? 'unavailable'
    // Only a check of the saved installation can find that a working connection needs attention. A person's failed
    // or cancelled sign-in, and other installations shown during it, leave the connection as it is.
    : input.connected ? (input.scope === 'connection' && (blockers.length || (installations.length && !installations.some(item => item.usable))) ? 'needs_attention' : 'connected')
    : has(FLOW_SIGN_IN) ? 'sign_in_required'
    : has(FLOW_RETRY) ? 'retryable_error'
    : has(['install_request_pending']) ? 'waiting_on_owner'
    : input.choose ? 'choose'
    : !blockers.length && !installations.length ? 'sign_in_required'
    : 'action_required';
  const all = [...blockers, ...installationBlockers];
  const slug = githubAppSlug(), setup = githubSetup();
  return {
    version: GITHUB_DIAGNOSIS_VERSION, checked_at: new Date().toISOString(), revision: input.revision, attempted_by: input.attemptedBy,
    github_user: input.githubUser ? { id: String(input.githubUser.id), login: input.githubUser.login } : null,
    outcome,
    primary_action: outcome === 'choose' ? null
      // On a working connection only the person's own failed step has an action.
      : outcome === 'connected' ? primaryAction(blockers)
      : outcome === 'sign_in_required' && !all.length ? CONNECT : primaryAction(all),
    blockers, installations, app: { slug, install_url: setup.install_url },
  };
}

const diagnosisPath = (orgId: string) => `organizations/${orgId}/publishing_authorizations/github_diagnosis`;
/** Firestore rejects undefined values; the projection is plain JSON. */
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value));

/**
 * Persist a diagnosis for an attempt or check by `userId`. `identity` is set
 * only after OAuth proved the GitHub user; without it the same person keeps
 * a previously proven identity. `organization` defaults to the
 * organization-level view of this diagnosis, except that one person's
 * attempt on a saved connection leaves the shared state as it was.
 */
export async function recordGithubDiagnosis(orgId: string, diagnosis: GithubConnectionDiagnosis, meta: {
  userId: string | null; scope?: DiagnosisScope; identity?: GithubIdentity | null; organization?: GithubConnectionDiagnosis | null;
  selectionExpiresAt?: number | null; recheckedAt?: number | null; expectedSequence?: number;
}): Promise<boolean> {
  const store = getStore(), path = diagnosisPath(orgId);
  const previous = await store.getDoc<StoredDiagnosis>(path);
  const scope = meta.scope ?? 'attempt';
  const kept: GithubIdentity | null = previous && previous.user_id === meta.userId && previous.verified_user && previous.identity_verified_at
    && (!diagnosis.github_user || diagnosis.github_user.id === previous.verified_user.id)
    ? { user: previous.verified_user, verifiedAt: previous.identity_verified_at, accounts: previous.accounts ?? [] } : null;
  const identity = meta.identity !== undefined ? meta.identity : kept;
  const stored: StoredDiagnosis = plain({
    ...diagnosis, user_id: meta.userId, expires_at: Date.now() + DIAGNOSIS_TTL_MS, scope,
    verified_user: identity?.user ?? null, identity_verified_at: identity?.verifiedAt ?? null, accounts: identity?.accounts ?? [],
    selection_expires_at: meta.selectionExpiresAt ?? null,
    organization: meta.organization !== undefined ? meta.organization
      : scope === 'attempt' && CONNECTED.includes(diagnosis.outcome) ? previous?.organization ?? null : organizationView(diagnosis),
    sequence: (previous?.sequence ?? 0) + 1,
    rechecked_at: meta.recheckedAt ?? previous?.rechecked_at ?? null,
  });
  if (meta.expectedSequence === undefined) { await store.setDoc(path, stored); return true; }
  if (!previous) {
    if (meta.expectedSequence !== 0) return false;
    return store.createDocIfMissing(path, stored);
  }
  return Boolean(await store.compareAndUpdateDoc<StoredDiagnosis>(path, current => (current.sequence ?? 0) === meta.expectedSequence, stored));
}

/** Sequence of the raw document, also after its 24-hour expiry, for a compare-and-update. */
export async function githubDiagnosisSequence(orgId: string): Promise<number> {
  return (await getStore().getDoc<StoredDiagnosis>(diagnosisPath(orgId)))?.sequence ?? 0;
}

export async function storedGithubDiagnosis(orgId: string): Promise<StoredDiagnosis | null> {
  const stored = await getStore().getDoc<StoredDiagnosis>(diagnosisPath(orgId));
  if (!stored || stored.version !== GITHUB_DIAGNOSIS_VERSION || !(stored.expires_at > Date.now())) return null;
  return stored;
}

/** The GitHub identity `userId` proved with OAuth within the last hour, if any. */
export function trustedGithubIdentity(stored: StoredDiagnosis | null, userId: string, now = Date.now()) {
  return stored && stored.user_id === userId && stored.verified_user && stored.identity_verified_at
    && now - stored.identity_verified_at < GITHUB_IDENTITY_TRUST_MS ? stored.verified_user : null;
}

/** The only projection of a stored diagnosis that may leave the server. */
export function publicDiagnosis(value: GithubConnectionDiagnosis): GithubConnectionDiagnosis {
  const { version, checked_at, revision, attempted_by, github_user, outcome, primary_action, blockers, installations, app } = value;
  return plain({ version, checked_at, revision, attempted_by, github_user, outcome, primary_action, blockers, installations, app });
}

/**
 * What every publishing admin and organization API key may see: the state of
 * the organization's connection. It never contains a person's GitHub
 * identity, Typeroll user id, the other accounts their sign-in showed, or
 * links that carry their single sign-on request. Installations are listed
 * only for a saved connection.
 */
export function organizationView(value: GithubConnectionDiagnosis): GithubConnectionDiagnosis {
  const saved = CONNECTED.includes(value.outcome);
  const blockers = value.blockers.filter(blocker => blocker.code !== 'not_org_owner')
    .map(({ action, ...blocker }) => action && blocker.code !== 'sso_authorization_required' ? { ...blocker, action } : blocker);
  const installations = saved ? value.installations : [];
  const all = [...blockers, ...installations.flatMap(item => item.blockers)];
  return publicDiagnosis({ ...value, attempted_by: null, github_user: null, blockers, installations,
    primary_action: value.outcome === 'choose' ? null : value.outcome === 'connected' ? primaryAction(blockers)
      : primaryAction(all) ?? (value.outcome === 'sign_in_required' ? CONNECT : null) });
}

/** Diagnosis for a connection with no relevant attempt on record. */
export function synthesizedDiagnosis(connection: Connection, attemptedBy: string | null = null): GithubConnectionDiagnosis {
  const setup = githubSetup();
  if (!setup.available) {
    return composeDiagnosis({ revision: connection.revision, attemptedBy, connected: connection.status === 'connected',
      blockers: [githubBlocker(setup.encryption_available ? 'publisher_app_misconfigured' : 'encryption_unavailable')] });
  }
  if (connection.status === 'connected' && connection.github) {
    const account = { login: connection.github.owner, type: connection.github.account_type ?? 'Organization', id: connection.github.account_id } as const;
    return composeDiagnosis({ revision: connection.revision, attemptedBy, connected: true, scope: 'connection',
      installations: [{ installation_id: connection.github.installation_id, account, usable: true, blockers: [] }] });
  }
  return composeDiagnosis({ revision: connection.revision, attemptedBy });
}

/**
 * Current diagnosis for the Publishing card or the public API. A stored
 * diagnosis applies while the connection revision is unchanged. In the
 * portal an unfinished attempt is shown only to the person who made it, as
 * its actions (choices, sign-in) belong to that person's GitHub identity;
 * other admins see the state of a saved connection. Without a viewer (the
 * public API) only the organization-level view is returned.
 */
export async function currentGithubDiagnosis(orgId: string, viewer?: { userId: string }): Promise<GithubConnectionDiagnosis> {
  const connection = await getConnection(orgId, 'github');
  const setup = githubSetup();
  const stored = setup.available ? await storedGithubDiagnosis(orgId) : null;
  const organization = stored?.organization?.revision === connection.revision ? stored.organization : null;
  if (stored && viewer && stored.user_id === viewer.userId && stored.revision === connection.revision) return personalView(stored, organization);
  if (organization && (!viewer || connection.status === 'connected')) return publicDiagnosis(organization);
  return synthesizedDiagnosis(connection, viewer?.userId ?? null);
}

/** The attempt as its own person sees it now. Every state keeps one action that still works. */
function personalView(stored: StoredDiagnosis, organization: GithubConnectionDiagnosis | null): GithubConnectionDiagnosis {
  const own = publicDiagnosis(stored);
  if (CONNECTED.includes(own.outcome)) {
    if (stored.scope !== 'attempt' || !organization) return own;
    // The person's own findings are shown beside the shared state of the saved connection.
    const rows = own.installations.filter(row => !organization.installations.some(item => item.installation_id === row.installation_id));
    return { ...own, outcome: organization.outcome, primary_action: own.primary_action ?? organization.primary_action,
      installations: [...organization.installations, ...rows] };
  }
  const identity = trustedGithubIdentity(stored, stored.user_id ?? '');
  if (stored.selection_expires_at && stored.selection_expires_at <= Date.now()) {
    // A choice is valid for 10 minutes. Afterwards it is made again: by Check again while the
    // proven identity is trusted, otherwise by signing in again.
    const action: GithubDiagnosisAction = identity ? { kind: 'retry', label: 'Check again' } : { kind: 'sign_in', label: 'Sign in to GitHub again' };
    const expired: GithubBlocker = { ...githubBlocker('state_expired'), action,
      message: 'Your GitHub account choice expired after 10 minutes, so nothing was connected. Choose again to continue.' };
    const installations = own.installations.map(row => ({ ...row, blockers: row.blockers.map(({ action: fix, ...blocker }) =>
      fix && fix.kind !== 'confirm_account_change' ? { ...blocker, action: fix } : blocker) }));
    return { ...composeDiagnosis({ revision: own.revision, attemptedBy: own.attempted_by, githubUser: own.github_user, blockers: [expired], installations }),
      checked_at: own.checked_at, primary_action: action };
  }
  // Check again needs the identity OAuth proved within the hour; after that only a sign-in helps.
  if (own.primary_action?.kind === 'retry' && !identity) own.primary_action = { kind: 'sign_in', label: 'Sign in to GitHub to check again' };
  return own;
}

/** Map any failure to one blocker. Provider bodies never reach the message. */
export function blockerFromError(error: unknown, context: BlockerContext = {}): GithubBlocker {
  if (error instanceof GithubFlowError) return error.blocker;
  if (error instanceof ConnectionError && error.code) {
    if (error.code === 'github_expiring_authorization_required') return githubBlocker('expiring_tokens_disabled', context);
    if ((GITHUB_BLOCKER_CODES as readonly string[]).includes(error.code)) return githubBlocker(error.code as GithubBlockerCode, context);
  }
  if (error instanceof ProviderError) {
    if (error.ssoUrl) return githubBlocker('sso_authorization_required', { ...context, ssoUrl: error.ssoUrl });
    if (error.rateLimited) return githubBlocker('github_rate_limited', { ...context, retryAfter: error.retryAfter });
    return githubBlocker('github_unavailable', { ...context, retryAfter: error.retryAfter });
  }
  if (error instanceof ProviderTransportError) return githubBlocker('github_unavailable', context);
  if (error instanceof ConnectionError && error.status === 409) return githubBlocker('revision_conflict', context);
  return githubBlocker('github_unavailable', context);
}
