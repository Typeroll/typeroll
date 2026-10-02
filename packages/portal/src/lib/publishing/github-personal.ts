// Shared by the server diagnosis and the GitHub card; no server imports.
import type { GithubConnectionDiagnosis, GithubDiagnosisAction } from './github-diagnosis';

/**
 * The person's own personal account when it is ready on GitHub and only their authorization is missing. Connecting
 * it needs one OAuth confirmation, so the card names that step instead of asking for a sign-in.
 */
export function readyPersonalAccount(diagnosis: Pick<GithubConnectionDiagnosis, 'outcome' | 'github_user' | 'installations'>): string | null {
  const login = diagnosis.github_user?.login.toLowerCase();
  if (diagnosis.outcome !== 'action_required' || !login) return null;
  return diagnosis.installations.find(row => row.usable && row.account.type === 'User' && row.account.login.toLowerCase() === login)?.account.login ?? null;
}

/** One confirmation on GitHub connects a ready personal account. Sign-in wording only when no identity is trusted. */
export function connectPersonalAction(login: string, trusted: boolean): GithubDiagnosisAction {
  return { kind: 'sign_in', label: trusted ? `Connect @${login}` : `Sign in to GitHub to connect @${login}` };
}
