// Pure decisions of the GitHub card: what the next-step box says and when the
// card checks GitHub again by itself after the person comes back.
import type {
  GithubBlocker, GithubBlockerWho, GithubConnectionDiagnosis, GithubDiagnosisAction, GithubDiagnosisOutcome,
} from '../lib/publishing/github-diagnosis';
import { connectPersonalAction, readyPersonalAccount } from '../lib/publishing/github-personal';

/** The person's own GitHub flow, from GET /api/orgs/publishing. Absent on older servers. */
export type GithubAttempt = {
  /** Check again can use the GitHub identity this person proved by sign-in within the hour. */
  recheck_available: boolean;
  /** An App installation this person opened from Typeroll, with no return from GitHub since. */
  installation_started_at: string | null;
};

/** Who must act. Shown as its own label above the reason, never as the start of the sentence. */
export const WHO: Record<GithubBlockerWho, string> = {
  you: 'You', github_owner: 'GitHub organization owner', publisher: 'Typeroll publisher', typeroll_admin: 'Typeroll administrator',
};
const MUST_ACT: Record<Exclude<GithubBlockerWho, 'you'>, string> = {
  github_owner: 'A GitHub organization owner must act first.', publisher: 'The Typeroll publisher must act first.',
  typeroll_admin: 'A Typeroll administrator must act first.',
};
export const SUMMARY: Record<GithubDiagnosisOutcome, string> = {
  unavailable: 'GitHub cannot be connected until the publisher finishes setup.',
  sign_in_required: 'Sign in to GitHub to connect this organization’s repositories.',
  action_required: 'GitHub is not connected yet. See the reason below.',
  waiting_on_owner: 'Waiting for a GitHub organization owner.',
  choose: 'Choose which GitHub account publishes this organization’s sites.',
  connected: 'GitHub is connected.',
  needs_attention: 'GitHub is connected but needs attention.',
  retryable_error: 'GitHub did not respond. Nothing was changed.',
};
/** Codes that explain without blocking the next step (GITHUB_NOTE_CODES on the server). Shown apart from the reason. */
export const NOTE_CODES: readonly string[] = ['setup_url_missing'];
export const isNote = (blocker: Pick<GithubBlocker, 'code'>) => NOTE_CODES.includes(blocker.code);

/** The reason whose fix is the primary action, else the first top-level reason. */
export function primaryReason(blockers: GithubBlocker[], installations: GithubConnectionDiagnosis['installations'], action: GithubDiagnosisAction | null): GithubBlocker | undefined {
  const reasons = blockers.filter(blocker => !isNote(blocker));
  return [...reasons, ...installations.flatMap(item => item.blockers)].find(blocker => blocker.action && action && blocker.action.kind === action.kind
    && blocker.action.url === action.url && blocker.action.installation_id === action.installation_id) ?? reasons[0];
}

export const CONFIRM_ONCE = 'GitHub asks you to confirm once; you come straight back here.';

/** The person's own personal account, when one GitHub confirmation is all that is left. */
export function personalConnection(diagnosis: GithubConnectionDiagnosis, action: GithubDiagnosisAction | null): string | null {
  const login = readyPersonalAccount(diagnosis);
  return login && action?.kind === 'sign_in' && action.label === connectPersonalAction(login, true).label ? login : null;
}

/** The summary line names the next step, or who must take it. */
export function nextStepSummary(outcome: GithubDiagnosisOutcome, diagnosis: GithubConnectionDiagnosis,
  action: GithubDiagnosisAction | null, blocker: GithubBlocker | undefined): string {
  if (outcome !== 'action_required' || diagnosis.outcome !== 'action_required') return SUMMARY[outcome];
  const personal = personalConnection(diagnosis, action);
  if (personal) return `GitHub is not connected yet. Connect @${personal} to finish.`;
  if (action && (!blocker || blocker.who === 'you')) return `GitHub is not connected yet. Next: ${action.label}.`;
  if (blocker && blocker.who !== 'you') return `GitHub is not connected yet. ${MUST_ACT[blocker.who]}`;
  return SUMMARY.action_required;
}

/** Outcomes a check after returning from GitHub can change. Choices, a saved connection and publisher setup cannot. */
const RECHECKABLE: GithubDiagnosisOutcome[] = ['action_required', 'waiting_on_owner'];
const SETTLED: GithubDiagnosisOutcome[] = ['unavailable', 'choose', 'connected', 'needs_attention'];
/** At most one automatic check per this interval. The server also answers repeated checks within five seconds from storage. */
export const AUTO_RECHECK_INTERVAL_MS = 10_000;

/**
 * Whether the card checks GitHub again by itself, on page load or when the tab regains focus. Only with an
 * identity Check again can use; a check never triggers another one.
 */
export function shouldAutoRecheck(input: {
  available: boolean; connected: boolean; outcome: GithubDiagnosisOutcome; attempt?: GithubAttempt | null;
  returned?: string | null; working: boolean; lastCheck: number | null; now: number;
}): boolean {
  if (!input.available || input.connected || input.working || !input.attempt?.recheck_available) return false;
  if (SETTLED.includes(input.outcome)) return false;
  if (input.lastCheck !== null && input.now - input.lastCheck < AUTO_RECHECK_INTERVAL_MS) return false;
  return RECHECKABLE.includes(input.outcome) || Boolean(input.attempt.installation_started_at) || input.returned === 'installation_returned';
}

/** The callback values after which the page load itself already shows a fresh result. */
export const freshReturn = (returned: string | null) => Boolean(returned) && !['installation_returned', 'install_requested'].includes(returned!);

/** Shown while the person may be back from GitHub's installation page without a return to Typeroll. */
export function returnHint(input: { connected: boolean; diagnosis: GithubConnectionDiagnosis; attempt?: GithubAttempt | null; returned?: string | null }): string | null {
  if (input.connected) return null;
  if (input.returned === 'install_requested') return 'Your installation request was sent to the organization’s owners. After an owner approves it on GitHub, select Check again.';
  if (!input.attempt?.installation_started_at && input.returned !== 'installation_returned') return null;
  // A check already found an account that can be connected: its next step is shown instead.
  if (SETTLED.includes(input.diagnosis.outcome) || input.diagnosis.installations.some(row => row.usable)) return null;
  return input.attempt?.recheck_available ? 'Back from GitHub? We check automatically — or select Check again.'
    : 'Back from GitHub? Sign in to GitHub so Typeroll can find the installation.';
}
