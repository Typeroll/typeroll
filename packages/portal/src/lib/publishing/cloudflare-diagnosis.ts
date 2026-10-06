// Cloudflare connection diagnosis: one persisted answer to "why is Cloudflare
// not connected for this Hosting Group, and who must do what next?"
//
// Every exit of the browser flow (start, OAuth callback, account selection and
// Check again) records this document per organization and Hosting Group. It
// lists the Cloudflare accounts the person authorized, whether each can be
// used, every reason one cannot, who can fix it and one action per fix. The
// portal card, the public API and MCP all read the same projection.
//
// It never contains tokens, OAuth codes, PKCE verifiers, state values or
// provider response bodies. Only Cloudflare account ids and names, granted
// permission names, links to dash.cloudflare.com or the documentation and
// fixed messages are stored.

import { getStore } from '../datastore';
import { cloudflareSetup } from './cloudflare-config';
import { ConnectionError, getConnection, type Connection } from './connections';
import { ProviderError, ProviderTransportError } from './providers.mjs';

export const CLOUDFLARE_DIAGNOSIS_VERSION = 1;
const DIAGNOSIS_TTL_MS = 24 * 60 * 60 * 1000;
/** A Cloudflare sign-in, and an account choice made from it, are valid for this long. */
export const CLOUDFLARE_SIGN_IN_TTL_MS = 10 * 60 * 1000;
/** Tokens from one consent may be reused by Check again to offer the choice again for this long. */
export const CLOUDFLARE_CONSENT_TRUST_MS = 60 * 60 * 1000;
export const CLOUDFLARE_TROUBLESHOOTING_URL = 'https://typeroll.com/docs/guides/cloudflare-troubleshooting/';

export type CloudflareDiagnosisOutcome = 'unavailable' | 'sign_in_required' | 'sign_in_pending' | 'action_required' | 'choose'
  | 'connected' | 'needs_attention' | 'retryable_error';
export type CloudflareBlockerWho = 'you' | 'cloudflare_account_admin' | 'organization_admin' | 'publisher' | 'typeroll_admin';
export type CloudflareBlockerCode =
  | 'oauth_cancelled' | 'state_expired' | 'wrong_browser' | 'session_expired' | 'permissions_missing' | 'no_eligible_account'
  | 'too_many_accounts' | 'account_choice_expired' | 'pages_access_denied' | 'revision_conflict' | 'locked_to_account'
  | 'claimed_by_other_organization' | 'authorization_revoked' | 'provider_unavailable' | 'rate_limited' | 'publisher_oauth_misconfigured';
export const CLOUDFLARE_BLOCKER_CODES: readonly CloudflareBlockerCode[] = [
  'oauth_cancelled', 'state_expired', 'wrong_browser', 'session_expired', 'permissions_missing', 'no_eligible_account',
  'too_many_accounts', 'account_choice_expired', 'pages_access_denied', 'revision_conflict', 'locked_to_account',
  'claimed_by_other_organization', 'authorization_revoked', 'provider_unavailable', 'rate_limited', 'publisher_oauth_misconfigured',
];

export interface CloudflareDiagnosisAction {
  /**
   * sign_in — start Cloudflare sign-in again (a new consent).
   * retry — check again without a new consent.
   * link — open url (dash.cloudflare.com or documentation) in a new tab.
   * contact_publisher — the operator of this Typeroll installation must act; url explains what.
   */
  kind: 'sign_in' | 'retry' | 'link' | 'contact_publisher';
  label: string;
  url?: string;
}
export interface CloudflareAccountRef { id: string; name: string }
export interface CloudflareBlocker {
  code: CloudflareBlockerCode;
  who: CloudflareBlockerWho;
  message: string;
  action?: CloudflareDiagnosisAction;
  retry_after?: number;
  /** Cloudflare OAuth scopes Typeroll needs that the consent did not grant. */
  missing_permissions?: string[];
  /** The account a reason is about. */
  account?: CloudflareAccountRef;
  /** The account this connection must keep using. */
  previous_account?: CloudflareAccountRef;
}
export interface CloudflareDiagnosisAccount extends CloudflareAccountRef {
  usable: boolean;
  blockers: CloudflareBlocker[];
  /**
   * Other Organizations that already use this account and that the person who signed in administers. Connecting
   * it needs a confirmation naming them. Only in that person's own view; never in the organization-level view.
   */
  shared_with?: string[];
}
export interface CloudflareConnectionDiagnosis {
  version: typeof CLOUDFLARE_DIAGNOSIS_VERSION;
  checked_at: string;
  hosting_group_id: string;
  /** Connection revision this diagnosis describes. A newer revision makes it stale. */
  revision: string;
  /** Typeroll user (or `api-key:<prefix>`) whose attempt or check produced it. */
  attempted_by: string | null;
  outcome: CloudflareDiagnosisOutcome;
  primary_action: CloudflareDiagnosisAction | null;
  blockers: CloudflareBlocker[];
  /** Accounts the person authorized on Cloudflare, or the saved account. */
  accounts: CloudflareDiagnosisAccount[];
  /** Until when an offered account choice can be selected. */
  selection_expires_at: string | null;
  /** When a sign-in that has not returned from Cloudflare yet was started. */
  sign_in_started_at: string | null;
  /** Check again can verify something now: the saved connection, or the last consent's accounts (for one hour). */
  recheck_available: boolean;
}
type DiagnosisScope = 'attempt' | 'connection';
export interface StoredCloudflareDiagnosis extends CloudflareConnectionDiagnosis {
  user_id: string | null;
  expires_at: number;
  /** attempt: one person's sign-in, choice or check, shown only to them. connection: a check of the saved connection. */
  scope: DiagnosisScope;
  /** When the consent whose tokens Check again may reuse was given. */
  consented_at: number | null;
  /** The organization-level state every publishing admin and organization API key may see. */
  organization: CloudflareConnectionDiagnosis | null;
  sequence: number;
  rechecked_at: number | null;
}

export class CloudflareFlowError extends ConnectionError {
  diagnosis?: CloudflareConnectionDiagnosis;
  /** The request matched no flow this person started, so nothing was recorded. */
  unrecorded?: boolean;
  constructor(public blocker: CloudflareBlocker, status = 409) { super(blocker.message, status, blocker.code); }
}

export interface CloudflareBlockerContext {
  account?: CloudflareAccountRef;
  previous?: CloudflareAccountRef;
  /** Missing OAuth scopes. */
  permissions?: string[];
  retryAfter?: number | null;
  /** How a retry happens: through a new consent or a check that reuses the last one. */
  retry?: 'sign_in' | 'recheck';
  /** A fixed description of a publisher configuration problem. Never provider text. */
  detail?: string;
  /** Where the failure happened, to tell an authorization problem from a Pages permission problem. */
  step?: 'token' | 'accounts' | 'account' | 'pages';
  limit?: number;
}

/** Human names of the OAuth scopes Typeroll requires, as Cloudflare's consent page lists them. */
const SCOPE_NAMES: Record<string, string> = {
  'account-settings.read': 'Account Settings: Read', 'page.read': 'Cloudflare Pages: Read', 'page.write': 'Cloudflare Pages: Edit',
  'workers-r2.read': 'Workers R2 Storage: Read', 'workers-r2.write': 'Workers R2 Storage: Edit', offline_access: 'Offline access',
};
export const cloudflareScopeName = (scope: string) => SCOPE_NAMES[scope] ?? scope;
const help = (code: CloudflareBlockerCode) => `${CLOUDFLARE_TROUBLESHOOTING_URL}#${code}`;
const portalHost = () => { try { return new URL(process.env.PORTAL_PUBLIC_URL ?? '').host; } catch { return ''; } };
const named = (account?: CloudflareAccountRef) => account ? account.name : 'this Cloudflare account';
const CONNECT_AGAIN: CloudflareDiagnosisAction = { kind: 'sign_in', label: 'Connect Cloudflare again' };
const retryAction = (context: CloudflareBlockerContext, label = 'Try again'): CloudflareDiagnosisAction =>
  context.retry === 'recheck' ? { kind: 'retry', label } : { kind: 'sign_in', label: 'Connect Cloudflare again' };
const membersUrl = (account?: CloudflareAccountRef) => account && /^[a-f0-9]{32}$/.test(account.id) ? `https://dash.cloudflare.com/${account.id}/members` : 'https://dash.cloudflare.com/';
const waitText = (seconds: number) => seconds < 120 ? `${seconds} seconds` : `${Math.ceil(seconds / 60)} minutes`;

/** Fixed, user-facing explanation and fix for each blocker. No provider text is included. */
export function cloudflareBlocker(code: CloudflareBlockerCode, context: CloudflareBlockerContext = {}): CloudflareBlocker {
  const name = named(context.account);
  const make = (who: CloudflareBlockerWho, message: string, action?: CloudflareDiagnosisAction, extra: Partial<CloudflareBlocker> = {}): CloudflareBlocker =>
    plain({ code, who, message, ...(action ? { action } : {}), ...(context.account ? { account: context.account } : {}), ...extra });
  switch (code) {
    case 'oauth_cancelled':
      return make('you', 'Cloudflare sign-in was cancelled, so nothing was connected. Connect Cloudflare again and select Authorize on Cloudflare’s consent page.', CONNECT_AGAIN);
    case 'state_expired':
      return make('you', 'This Cloudflare sign-in expired or was already used, so nothing was connected. A sign-in is valid once, for 10 minutes, in the browser that started it. Connect Cloudflare again.', CONNECT_AGAIN);
    case 'wrong_browser':
      return make('you', `Cloudflare returned to a different browser, profile or address than the one that started sign-in, so nothing was connected. Start again in this browser${portalHost() ? ` at ${portalHost()}` : ''}.`, CONNECT_AGAIN);
    case 'session_expired':
      return make('you', 'Your Typeroll session ended while you were on Cloudflare, so nothing was connected. Connect Cloudflare again.', CONNECT_AGAIN);
    case 'permissions_missing': {
      const missing = context.permissions ?? [];
      const list = missing.map(cloudflareScopeName).join(', ') || 'the requested permissions';
      return make('you', `Cloudflare did not grant permissions Typeroll needs (${list}), so nothing was connected. Connect Cloudflare again and approve every requested permission. If Cloudflare does not offer them, your role in the account does not include them: ask a Super Administrator of the account to connect it, or to give you a role that does.`,
        { kind: 'sign_in', label: 'Connect Cloudflare again' }, { missing_permissions: missing });
    }
    case 'no_eligible_account':
      return make('you', 'Cloudflare did not give Typeroll access to any account, so nothing was connected. Connect Cloudflare again and select the account that should host this organization’s sites on Cloudflare’s consent page.', CONNECT_AGAIN);
    case 'too_many_accounts':
      return make('you', `You authorized more than ${context.limit ?? 1000} Cloudflare accounts. Connect Cloudflare again and select only the account that should host this organization’s sites.`, CONNECT_AGAIN);
    case 'account_choice_expired':
      return make('you', 'Your Cloudflare account choice expired after 10 minutes, so nothing was connected. Choose again to continue.',
        context.retry === 'recheck' ? { kind: 'retry', label: 'Check again' } : CONNECT_AGAIN);
    case 'pages_access_denied':
      return make('cloudflare_account_admin', `Cloudflare refused access to Cloudflare Pages in ${name}. Typeroll creates each site’s Pages project there, so your role in ${name} must include Cloudflare Pages (for example Administrator or Cloudflare Pages Admin). Ask a Super Administrator of ${name} to change your role, then connect Cloudflare again.`,
        { kind: 'link', label: `Open members of ${name}`, url: membersUrl(context.account) });
    case 'revision_conflict':
      return make('you', 'The Cloudflare connection changed in another tab or session. Nothing was overwritten. Review the current state and try again.', retryAction(context, 'Check again'));
    case 'locked_to_account': {
      const previous = named(context.previous);
      return make('you', `This connection must keep using ${previous}, because sites and media already use it. Cloudflare authorized ${context.account ? name : 'other accounts'} instead, so nothing was connected. Connect Cloudflare again and select ${previous}. Moving to another account needs a hosting migration.`,
        { kind: 'sign_in', label: `Connect ${previous} again` }, context.previous ? { previous_account: context.previous } : {});
    }
    case 'claimed_by_other_organization':
      // Nothing about the other Organization is named: the person may not be a member of it.
      return make('organization_admin', `${name} is already used by another Typeroll Organization. Several Organizations may share one Cloudflare account, but only an owner or admin of an Organization that already uses it can connect it here, so that both are under common control. If you administer that Organization too, sign in to Typeroll as that person and connect it again. Otherwise ask an owner or admin of that Organization, or Typeroll support.`,
        { kind: 'link', label: 'How shared Cloudflare accounts work', url: help(code) });
    case 'authorization_revoked':
      return make('you', `Cloudflare no longer accepts Typeroll’s authorization for ${name}. It may have been revoked on Cloudflare or not used for a long time. Reconnect Cloudflare with the same account; sites and media are kept.`,
        { kind: 'sign_in', label: 'Reconnect Cloudflare' });
    case 'provider_unavailable':
      return make('you', 'Cloudflare did not respond as expected. Nothing was changed. Try again in a moment.', retryAction(context), context.retryAfter ? { retry_after: context.retryAfter } : {});
    case 'rate_limited': {
      const seconds = context.retryAfter ?? 60;
      return make('you', `Cloudflare is limiting requests right now. Nothing was changed. Try again in ${waitText(seconds)}.`, retryAction(context), { retry_after: seconds });
    }
    case 'publisher_oauth_misconfigured':
      return make('publisher', `The publisher’s Cloudflare sign-in is not configured correctly${context.detail ? ` (${context.detail})` : ''}. The operator of this Typeroll installation must fix it. Nothing in your Cloudflare account needs to change.`,
        { kind: 'contact_publisher', label: 'What the publisher must change', url: help(code) });
  }
}

const CONNECTED: CloudflareDiagnosisOutcome[] = ['connected', 'needs_attention'];
const CONNECT: CloudflareDiagnosisAction = { kind: 'sign_in', label: 'Connect Cloudflare' };
const FLOW_SIGN_IN: CloudflareBlockerCode[] = ['oauth_cancelled', 'state_expired', 'wrong_browser', 'session_expired'];
const FLOW_RETRY: CloudflareBlockerCode[] = ['provider_unavailable', 'rate_limited', 'revision_conflict'];
/** Order in which a blocker's action becomes the card's one primary button. */
const PRECEDENCE: CloudflareBlockerCode[] = [
  'publisher_oauth_misconfigured', 'session_expired', 'wrong_browser', 'state_expired', 'oauth_cancelled', 'revision_conflict',
  'rate_limited', 'provider_unavailable', 'account_choice_expired', 'permissions_missing', 'locked_to_account', 'no_eligible_account',
  'too_many_accounts', 'authorization_revoked', 'pages_access_denied', 'claimed_by_other_organization',
];

export function primaryAction(blockers: CloudflareBlocker[]): CloudflareDiagnosisAction | null {
  const ranked = blockers.filter(blocker => blocker.action)
    .sort((a, b) => Number(b.who === 'you') - Number(a.who === 'you') || PRECEDENCE.indexOf(a.code) - PRECEDENCE.indexOf(b.code));
  return ranked[0]?.action ?? null;
}

export function composeCloudflareDiagnosis(input: {
  groupId: string; revision: string; attemptedBy: string | null; blockers?: CloudflareBlocker[]; accounts?: CloudflareDiagnosisAccount[];
  connected?: boolean; choose?: boolean; selectionExpiresAt?: number | null; signInStartedAt?: number | null;
  /** attempt (default): one person's sign-in or choice. connection: a check of the saved connection. */
  scope?: DiagnosisScope;
}): CloudflareConnectionDiagnosis {
  const blockers = input.blockers ?? [], accounts = input.accounts ?? [];
  const has = (codes: CloudflareBlockerCode[]) => blockers.some(blocker => codes.includes(blocker.code));
  const outcome: CloudflareDiagnosisOutcome = has(['publisher_oauth_misconfigured']) ? 'unavailable'
    // Only a check of the saved connection can find that a working connection needs attention. A person's failed
    // or cancelled sign-in leaves the connection as it is.
    : input.connected ? (input.scope === 'connection' && (blockers.length || accounts.some(item => !item.usable)) ? 'needs_attention' : 'connected')
    : input.signInStartedAt ? 'sign_in_pending'
    : has(FLOW_SIGN_IN) ? 'sign_in_required'
    : has(FLOW_RETRY) ? 'retryable_error'
    : input.choose ? 'choose'
    : !blockers.length && !accounts.length ? 'sign_in_required'
    : 'action_required';
  const all = [...blockers, ...accounts.flatMap(item => item.blockers)];
  return {
    version: CLOUDFLARE_DIAGNOSIS_VERSION, checked_at: new Date().toISOString(), hosting_group_id: input.groupId, revision: input.revision,
    attempted_by: input.attemptedBy, outcome,
    primary_action: outcome === 'choose' ? null
      : outcome === 'sign_in_pending' ? { kind: 'sign_in', label: 'Start Cloudflare sign-in again' }
      : outcome === 'connected' ? primaryAction(blockers)
      : outcome === 'sign_in_required' && !all.length ? CONNECT : primaryAction(all),
    blockers, accounts,
    selection_expires_at: input.selectionExpiresAt ? new Date(input.selectionExpiresAt).toISOString() : null,
    sign_in_started_at: input.signInStartedAt ? new Date(input.signInStartedAt).toISOString() : null,
    recheck_available: Boolean(input.connected),
  };
}

/** Firestore paths need an even number of segments; Default keeps the organization-level location. */
const diagnosisPath = (orgId: string, groupId: string) => groupId === 'default'
  ? `organizations/${orgId}/publishing_authorizations/cloudflare_diagnosis`
  : `organizations/${orgId}/hosting_groups/${groupId}/publishing_authorizations/cloudflare_diagnosis`;
/** Firestore rejects undefined values; the projection is plain JSON. */
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value));

/**
 * Persist a diagnosis for an attempt or check by `userId`. `organization`
 * defaults to the organization-level view of this diagnosis, except that one
 * person's attempt on a saved connection leaves the shared state as it was.
 */
export async function recordCloudflareDiagnosis(orgId: string, diagnosis: CloudflareConnectionDiagnosis, meta: {
  userId: string | null; scope?: DiagnosisScope; organization?: CloudflareConnectionDiagnosis | null; consentedAt?: number | null;
  recheckedAt?: number | null;
}): Promise<void> {
  const store = getStore(), path = diagnosisPath(orgId, diagnosis.hosting_group_id);
  const previous = await store.getDoc<StoredCloudflareDiagnosis>(path);
  const scope = meta.scope ?? 'attempt';
  const stored: StoredCloudflareDiagnosis = plain({
    ...diagnosis, user_id: meta.userId, expires_at: Date.now() + DIAGNOSIS_TTL_MS, scope,
    consented_at: meta.consentedAt !== undefined ? meta.consentedAt : previous?.user_id === meta.userId ? previous?.consented_at ?? null : null,
    organization: meta.organization !== undefined ? meta.organization
      : scope === 'attempt' && CONNECTED.includes(diagnosis.outcome) ? previous?.organization ?? null : cloudflareOrganizationView(diagnosis),
    sequence: (previous?.sequence ?? 0) + 1,
    rechecked_at: meta.recheckedAt ?? previous?.rechecked_at ?? null,
  });
  await store.setDoc(path, stored);
}

export async function storedCloudflareDiagnosis(orgId: string, groupId: string): Promise<StoredCloudflareDiagnosis | null> {
  const stored = await getStore().getDoc<StoredCloudflareDiagnosis>(diagnosisPath(orgId, groupId));
  if (!stored || stored.version !== CLOUDFLARE_DIAGNOSIS_VERSION || !(stored.expires_at > Date.now())) return null;
  return stored;
}

/** The only projection of a stored diagnosis that may leave the server. */
export function publicCloudflareDiagnosis(value: CloudflareConnectionDiagnosis): CloudflareConnectionDiagnosis {
  const { version, checked_at, hosting_group_id, revision, attempted_by, outcome, primary_action, blockers, accounts, selection_expires_at, sign_in_started_at, recheck_available } = value;
  return plain({ version, checked_at, hosting_group_id, revision, attempted_by, outcome, primary_action, blockers, accounts, selection_expires_at, sign_in_started_at,
    recheck_available: Boolean(recheck_available) });
}

/**
 * What every publishing admin and organization API key may see: the state of
 * the connection. It never contains the Typeroll user who tried, or the
 * Cloudflare accounts a person authorized that are not the saved one. A
 * reason about such an account keeps its code, who acts and its fix, without
 * naming the account.
 */
export function cloudflareOrganizationView(value: CloudflareConnectionDiagnosis): CloudflareConnectionDiagnosis {
  const saved = CONNECTED.includes(value.outcome);
  const shared = (account?: CloudflareAccountRef) => !account || (saved && value.accounts.some(item => item.id === account.id));
  const anonymous = (blocker: CloudflareBlocker): CloudflareBlocker => shared(blocker.account) ? blocker
    : cloudflareBlocker(blocker.code, { permissions: blocker.missing_permissions, retryAfter: blocker.retry_after, previous: blocker.previous_account,
      retry: blocker.action?.kind === 'retry' ? 'recheck' : 'sign_in' });
  const blockers = [...value.blockers, ...(saved ? [] : value.accounts.flatMap(item => item.blockers))].map(anonymous)
    .filter((blocker, index, all) => all.findIndex(other => other.code === blocker.code) === index);
  // Which other Organizations a person administers is theirs to see, not every admin's of this one.
  const accounts = saved ? value.accounts.map(({ shared_with: _shared, ...account }) => account) : [];
  return publicCloudflareDiagnosis({ ...value, attempted_by: null, blockers, accounts, recheck_available: saved,
    primary_action: value.outcome === 'choose' ? null : value.outcome === 'sign_in_pending' ? null
      : value.outcome === 'connected' ? primaryAction(blockers) : primaryAction([...blockers, ...accounts.flatMap(item => item.blockers)])
        ?? (value.outcome === 'sign_in_required' ? CONNECT : null) });
}

/** Diagnosis for a connection with no relevant attempt or check on record. */
export function synthesizedCloudflareDiagnosis(connection: Connection, groupId: string, attemptedBy: string | null = null): CloudflareConnectionDiagnosis {
  if (!cloudflareSetup().available) {
    return composeCloudflareDiagnosis({ groupId, revision: connection.revision, attemptedBy, connected: connection.status === 'connected',
      blockers: [cloudflareBlocker('publisher_oauth_misconfigured', { detail: 'Cloudflare sign-in or encrypted credential storage is not set up' })] });
  }
  if (connection.status === 'connected' && connection.cloudflare) {
    return composeCloudflareDiagnosis({ groupId, revision: connection.revision, attemptedBy, connected: true, scope: 'connection',
      accounts: [{ id: connection.cloudflare.account_id, name: connection.cloudflare.account_name, usable: true, blockers: [] }] });
  }
  return composeCloudflareDiagnosis({ groupId, revision: connection.revision, attemptedBy });
}

/**
 * Current diagnosis for a Cloudflare card or the public API. A stored
 * diagnosis applies while the connection revision is unchanged. In the portal
 * an unfinished attempt is shown only to the person who made it; other admins
 * see the state of the connection. Without a viewer (the public API) only the
 * organization-level view is returned.
 */
export async function currentCloudflareDiagnosis(orgId: string, groupId: string, viewer?: { userId: string }, now = Date.now()): Promise<CloudflareConnectionDiagnosis> {
  const connection = await getConnection(orgId, 'cloudflare', groupId);
  const stored = cloudflareSetup().available ? await storedCloudflareDiagnosis(orgId, groupId) : null;
  const organization = stored?.organization?.revision === connection.revision ? stored.organization : null;
  if (stored && viewer && stored.user_id === viewer.userId && stored.revision === connection.revision) return cloudflarePersonalView(stored, organization, now);
  if (organization && (!viewer || connection.status === 'connected')) return organizationNow(organization, now);
  return synthesizedCloudflareDiagnosis(connection, groupId, viewer?.userId ?? null);
}

/** A pending sign-in that never came back is no longer pending for anyone. */
function organizationNow(organization: CloudflareConnectionDiagnosis, now: number) {
  const view = publicCloudflareDiagnosis(organization);
  if (view.outcome === 'sign_in_pending' && Date.parse(view.sign_in_started_at ?? '') + CLOUDFLARE_SIGN_IN_TTL_MS <= now) {
    return cloudflareOrganizationView({ ...composeCloudflareDiagnosis({ groupId: view.hosting_group_id, revision: view.revision, attemptedBy: null }), checked_at: view.checked_at });
  }
  if (view.outcome === 'choose' && Date.parse(view.selection_expires_at ?? '') <= now) {
    return cloudflareOrganizationView({ ...composeCloudflareDiagnosis({ groupId: view.hosting_group_id, revision: view.revision, attemptedBy: null,
      blockers: [cloudflareBlocker('account_choice_expired')] }), checked_at: view.checked_at });
  }
  return view;
}

/** The attempt as its own person sees it now. Every state keeps one action that still works. */
export function cloudflarePersonalView(stored: StoredCloudflareDiagnosis, organization: CloudflareConnectionDiagnosis | null, now = Date.now()): CloudflareConnectionDiagnosis {
  const own = publicCloudflareDiagnosis(stored);
  if (CONNECTED.includes(own.outcome)) {
    if (stored.scope !== 'attempt' || !organization) return own;
    // The person's own findings are shown beside the shared state of the saved connection.
    return { ...own, outcome: organization.outcome, primary_action: own.primary_action ?? organization.primary_action };
  }
  const trusted = Boolean(stored.consented_at && now - stored.consented_at < CLOUDFLARE_CONSENT_TRUST_MS);
  if (own.outcome === 'sign_in_pending' && Date.parse(own.sign_in_started_at ?? '') + CLOUDFLARE_SIGN_IN_TTL_MS <= now) {
    // Cloudflare never returned to Typeroll for this sign-in (closed tab, an error page on Cloudflare, or another browser).
    const blocker: CloudflareBlocker = { ...cloudflareBlocker('state_expired'),
      message: 'The Cloudflare sign-in you started did not return to Typeroll within 10 minutes, so nothing was connected. If Cloudflare showed an error, or you closed its tab, connect Cloudflare again.' };
    return { ...composeCloudflareDiagnosis({ groupId: own.hosting_group_id, revision: own.revision, attemptedBy: own.attempted_by, blockers: [blocker] }), checked_at: own.checked_at };
  }
  if (own.selection_expires_at && Date.parse(own.selection_expires_at) <= now && own.outcome === 'choose') {
    // A choice is valid for 10 minutes. Afterwards Check again offers it again while the consent is trusted (one hour),
    // otherwise only a new sign-in helps. The accounts that were offered stay listed.
    const blocker = cloudflareBlocker('account_choice_expired', { retry: trusted ? 'recheck' : 'sign_in' });
    return { ...composeCloudflareDiagnosis({ groupId: own.hosting_group_id, revision: own.revision, attemptedBy: own.attempted_by, blockers: [blocker], accounts: own.accounts }),
      checked_at: own.checked_at, selection_expires_at: own.selection_expires_at, recheck_available: trusted };
  }
  // Check again needs the consent's tokens from the last hour; after that only a new sign-in helps.
  if (own.primary_action?.kind === 'retry' && !trusted) own.primary_action = { kind: 'sign_in', label: 'Connect Cloudflare again' };
  own.recheck_available = trusted && own.outcome !== 'sign_in_pending';
  return own;
}

/** Map any failure to one blocker. Provider bodies never reach the message. */
export function cloudflareBlockerFromError(error: unknown, context: CloudflareBlockerContext = {}): CloudflareBlocker {
  if (error instanceof CloudflareFlowError) return error.blocker;
  if (error instanceof ConnectionError) {
    if (error.code && (CLOUDFLARE_BLOCKER_CODES as readonly string[]).includes(error.code)) return cloudflareBlocker(error.code as CloudflareBlockerCode, context);
    if (error.code === 'hosting_group_not_found' || error.status === 409) return cloudflareBlocker('revision_conflict', context);
    if (error.status === 503) return cloudflareBlocker('publisher_oauth_misconfigured', { ...context, detail: 'Cloudflare sign-in or encrypted credential storage is not set up' });
  }
  if (error instanceof ProviderError) {
    if (error.status === 429 || error.rateLimited) return cloudflareBlocker('rate_limited', { ...context, retryAfter: error.retryAfter });
    if (error.status === 401 || error.status === 403) {
      if (context.step === 'pages') return cloudflareBlocker('pages_access_denied', context);
      if (context.step === 'accounts') return cloudflareBlocker('permissions_missing', { ...context, permissions: ['account-settings.read'] });
      return cloudflareBlocker('authorization_revoked', context);
    }
    return cloudflareBlocker('provider_unavailable', { ...context, retryAfter: error.retryAfter });
  }
  if (error instanceof ProviderTransportError) return cloudflareBlocker('provider_unavailable', context);
  return cloudflareBlocker('provider_unavailable', context);
}
