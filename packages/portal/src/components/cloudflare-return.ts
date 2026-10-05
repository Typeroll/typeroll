// Pure decisions of a Cloudflare card: what the next-step box says, whether an
// account choice is still open, and what the person just came back with.
import type {
  CloudflareBlocker, CloudflareBlockerWho, CloudflareConnectionDiagnosis, CloudflareDiagnosisAction, CloudflareDiagnosisOutcome,
} from '../lib/publishing/cloudflare-diagnosis';
import type { PublishingState } from './PublishingCard';

/** Who must act. Shown as its own label above the reason, never as the start of the sentence. */
export const CLOUDFLARE_WHO: Record<CloudflareBlockerWho, string> = {
  you: 'You', cloudflare_account_admin: 'Cloudflare account administrator', publisher: 'Typeroll publisher', typeroll_admin: 'Typeroll administrator',
};
const MUST_ACT: Record<Exclude<CloudflareBlockerWho, 'you'>, string> = {
  cloudflare_account_admin: 'An administrator of the Cloudflare account must act first.', publisher: 'The Typeroll publisher must act first.',
  typeroll_admin: 'A Typeroll administrator must act first.',
};
export const CLOUDFLARE_SUMMARY: Record<CloudflareDiagnosisOutcome, string> = {
  unavailable: 'Cloudflare cannot be connected until the publisher finishes setup.',
  sign_in_required: 'Sign in to Cloudflare and approve access to connect the account that hosts this organization’s sites.',
  sign_in_pending: 'Waiting for Cloudflare. Finish signing in on Cloudflare’s page; you come straight back here.',
  action_required: 'Cloudflare is not connected yet. See the reason below.',
  choose: 'You authorized several Cloudflare accounts. Choose the one that hosts this organization’s sites.',
  connected: 'Cloudflare is connected.',
  needs_attention: 'Cloudflare is connected but needs attention.',
  retryable_error: 'Cloudflare did not respond. Nothing was changed.',
};
export const CLOUDFLARE_STATUS: Record<CloudflareDiagnosisOutcome, string> = {
  unavailable: 'Unavailable · Publisher setup required', sign_in_required: 'Not connected', sign_in_pending: 'Not connected · Waiting for Cloudflare',
  action_required: 'Not connected · Action required', choose: 'Setup incomplete · Choose an account', connected: 'Connected',
  needs_attention: 'Connected · Needs attention', retryable_error: 'Not connected · Try again',
};
export const CHOICE_EXPIRED = 'Your Cloudflare account choice expired after 10 minutes, so nothing was connected. Choose again to continue.';
/** Shown for ?cloudflare=state_expired: the return matched no sign-in started in this browser, so nothing was recorded. */
export const UNMATCHED_RETURN = 'This Cloudflare sign-in was not started in this browser or has expired, so nothing was changed. Sign-ins are valid once, for 10 minutes.';
export const SESSION_EXPIRED: CloudflareBlocker = { code: 'session_expired', who: 'you',
  message: 'Your Typeroll session ended while you were on Cloudflare, so nothing was connected. Connect Cloudflare again.',
  action: { kind: 'sign_in', label: 'Connect Cloudflare again' } };

/** The reason whose fix is the primary action, else the first top-level reason. */
export function cloudflarePrimaryReason(diagnosis: Pick<CloudflareConnectionDiagnosis, 'blockers' | 'accounts'>, action: CloudflareDiagnosisAction | null): CloudflareBlocker | undefined {
  return [...diagnosis.blockers, ...diagnosis.accounts.flatMap(item => item.blockers)].find(blocker => blocker.action && action
    && blocker.action.kind === action.kind && blocker.action.url === action.url && blocker.action.label === action.label) ?? diagnosis.blockers[0];
}

/** The summary line names the next step, or who must take it. */
export function cloudflareNextStep(diagnosis: CloudflareConnectionDiagnosis, action: CloudflareDiagnosisAction | null, blocker: CloudflareBlocker | undefined): string {
  if (diagnosis.outcome === 'sign_in_required' && blocker && action) return `Cloudflare is not connected. Next: ${action.label}.`;
  if (diagnosis.outcome !== 'action_required') return CLOUDFLARE_SUMMARY[diagnosis.outcome];
  if (blocker && blocker.who !== 'you') return `Cloudflare is not connected yet. ${MUST_ACT[blocker.who]}`;
  if (action) return `Cloudflare is not connected yet. Next: ${action.label}.`;
  return CLOUDFLARE_SUMMARY.action_required;
}

/**
 * The diagnosis as of `now`. A choice the server offered closes after 10 minutes even while the page stays open:
 * the card then says so and offers Check again (within an hour of signing in) or a new sign-in, instead of a
 * chooser that can no longer work. The accounts that were offered stay listed.
 */
export function cloudflareDiagnosisAt(diagnosis: CloudflareConnectionDiagnosis, now: number, closed = false): CloudflareConnectionDiagnosis {
  if (diagnosis.outcome !== 'choose') return diagnosis;
  // `closed`: the server no longer offers any of the accounts, whatever the clock says.
  if (!closed && (!diagnosis.selection_expires_at || Date.parse(diagnosis.selection_expires_at) > now)) return diagnosis;
  const action: CloudflareDiagnosisAction = diagnosis.recheck_available ? { kind: 'retry', label: 'Check again' } : { kind: 'sign_in', label: 'Connect Cloudflare again' };
  const blocker: CloudflareBlocker = { code: 'account_choice_expired', who: 'you', message: CHOICE_EXPIRED, action };
  return { ...diagnosis, outcome: 'action_required', primary_action: action, blockers: [blocker] };
}

/** Whether the Cloudflare part of a card is ready, waiting or needs action. */
export function cloudflareCardState(diagnosis: CloudflareConnectionDiagnosis): PublishingState {
  return diagnosis.outcome === 'connected' ? 'ready' : ['sign_in_pending', 'choose', 'needs_attention'].includes(diagnosis.outcome) ? 'waiting' : 'error';
}

/** Client fallback when a status response has no diagnosis (older servers or fixtures). */
export function fallbackCloudflareDiagnosis(input: { groupId: string; available: boolean; connection: { status: string; revision: string; cloudflare: { account_id?: string; account_name: string } | null };
  choices?: Array<{ id: string; name: string }> }): CloudflareConnectionDiagnosis {
  const connected = input.connection.status === 'connected' && Boolean(input.connection.cloudflare);
  const choose = !connected && (input.choices ?? []).length > 0;
  return { version: 1, checked_at: '', hosting_group_id: input.groupId, revision: input.connection.revision, attempted_by: null,
    outcome: !input.available ? 'unavailable' : connected ? 'connected' : choose ? 'choose' : 'sign_in_required',
    primary_action: connected || choose || !input.available ? null : { kind: 'sign_in', label: 'Connect Cloudflare' }, blockers: [],
    accounts: connected ? [{ id: input.connection.cloudflare!.account_id ?? '', name: input.connection.cloudflare!.account_name, usable: true, blockers: [] }]
      : choose ? input.choices!.map(choice => ({ ...choice, usable: true, blockers: [] })) : [],
    selection_expires_at: null, sign_in_started_at: null, recheck_available: connected };
}

const OUTCOME = /^[a-z_]{1,40}$/;
const GROUP = /^[a-z0-9][a-z0-9-]{0,63}$/;
let parsed: { result: string; groupId: string } | null | undefined;
/**
 * What the person just came back from Cloudflare with (`?cloudflare=…&hosting_group=…`). Read once per page load
 * and shared by every card, then removed from the address so a reload shows the stored diagnosis instead.
 */
export function readCloudflareReturn(): { result: string; groupId: string } | null {
  if (parsed !== undefined || typeof window === 'undefined') return parsed ?? null;
  const parameters = new URLSearchParams(window.location.search);
  const result = parameters.get('cloudflare'), group = parameters.get('hosting_group') ?? 'default';
  parsed = result && OUTCOME.test(result) && GROUP.test(group) ? { result, groupId: group } : null;
  if (parameters.has('cloudflare') || parameters.has('hosting_group')) {
    parameters.delete('cloudflare'); parameters.delete('hosting_group');
    const search = parameters.toString();
    window.history.replaceState(null, '', `${window.location.pathname}${search ? `?${search}` : ''}${window.location.hash}`);
  }
  return parsed;
}
/** For tests: forget the parsed return. */
export function resetCloudflareReturn() { parsed = undefined; }

export const formatTime = (iso: string | null) => {
  if (!iso) return '';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
};
