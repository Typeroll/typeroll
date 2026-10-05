import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ExternalLink } from 'lucide-react';
import PublishingCard, { type PublishingState } from './PublishingCard';
import PublishingGithubPermissions from './PublishingGithubPermissions';
import PublishingSetupStep from './PublishingSetupStep';
import type {
  GithubBlocker, GithubConnectionDiagnosis, GithubDiagnosisAction, GithubDiagnosisInstallation, GithubDiagnosisOutcome,
} from '../lib/publishing/github-diagnosis';
import {
  CONFIRM_ONCE, freshReturn, isNote, nextStepSummary, personalConnection, primaryReason, returnHint, shouldAutoRecheck, SUMMARY, WHO, type GithubAttempt,
} from './github-return';
import './PublishingGithubConnection.css';

export type GithubConnectionStatus = {
  status: 'connected' | 'disconnected'; revision: string;
  github: { owner: string; account_type?: 'Organization' | 'User'; repository_creation_state?: 'ready' | 'reconnect_required' } | null;
};
export type GithubPublishingData = {
  github: GithubConnectionStatus;
  github_setup: { available: boolean; app_configured?: boolean; encryption_available?: boolean; app_slug?: string | null; install_url: string | null };
  github_choices?: Array<{ owner: string; installation_id: string; account_type?: 'Organization' | 'User'; account_change?: { from_account_id: string; from_owner: string } }>;
  github_diagnosis?: GithubConnectionDiagnosis;
  github_attempt?: GithubAttempt;
};

const API = '/api/orgs/publishing/github';
const STATUS: Record<GithubDiagnosisOutcome, string> = {
  unavailable: 'Unavailable · Publisher setup required', sign_in_required: 'Not connected', action_required: 'Not connected · Action required',
  waiting_on_owner: 'Not connected · Waiting for an owner', choose: 'Setup incomplete · Choose an account', connected: 'Connected',
  needs_attention: 'Connected · Needs attention', retryable_error: 'Not connected · Try again',
};
const SESSION_EXPIRED: GithubBlocker = { code: 'session_expired', who: 'you',
  message: 'Your Typeroll session ended while you were on GitHub, so nothing was connected. Connect GitHub again.',
  action: { kind: 'sign_in', label: 'Sign in to GitHub again' } };
/** Shown for ?github=state_expired: the return matched no sign-in started in this browser, so nothing was recorded. */
const UNMATCHED_RETURN = 'This GitHub sign-in was not started in this browser or has expired, so nothing was changed. Sign-ins are valid once, for 10 minutes.';
const SIGN_IN_AGAIN: GithubDiagnosisAction = { kind: 'sign_in', label: 'Sign in to GitHub again' };

class GithubRequestError extends Error {}
async function request(path: string, body: unknown) {
  const response = await fetch(`${API}${path}`, { method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new GithubRequestError(data.error || 'Could not reach Typeroll. Check your connection and try again.');
  return data;
}

/** Client fallback when the status response has no diagnosis (older servers or fixtures). */
function fallbackDiagnosis(data: GithubPublishingData): GithubConnectionDiagnosis {
  const connected = data.github.status === 'connected' && data.github.github;
  return { version: 1, checked_at: '', revision: data.github.revision, attempted_by: null, github_user: null,
    outcome: connected ? 'connected' : data.github_setup.available ? 'sign_in_required' : 'unavailable',
    primary_action: connected || !data.github_setup.available ? null : { kind: 'sign_in', label: 'Connect GitHub' }, blockers: [],
    installations: connected ? [{ installation_id: '', account: { login: data.github.github!.owner, type: data.github.github!.account_type ?? 'Organization', id: '' }, usable: true, blockers: [] }] : [],
    app: { slug: data.github_setup.app_slug ?? null, install_url: data.github_setup.install_url } };
}

function Step(props: { id: string; title: string; state: PublishingState; status: string; children?: ReactNode }) {
  return <PublishingSetupStep provider="github" {...props} />;
}

const accountName = (account: Pick<GithubDiagnosisInstallation['account'], 'login' | 'type'>) => account.type === 'User' ? `@${account.login}` : account.login;

/** Who acts, as a label of its own, then the reason as a separate sentence. */
function Reason({ blocker }: { blocker: Pick<GithubBlocker, 'who' | 'message'> }) {
  return <div className="github-connection__reason">
    <p className="github-connection__who-line"><span className="github-connection__who">Who acts: {WHO[blocker.who]}</span></p>
    <p>{blocker.message}</p>
  </div>;
}

export default function PublishingGithubConnection({ data, disabled, disconnecting, returned, onRefresh, onDisconnect, feedback }: {
  data: GithubPublishingData; disabled: boolean; disconnecting: boolean;
  /** Value of ?github= when the person just came back from GitHub. */
  returned: string | null;
  onRefresh: () => Promise<void>; onDisconnect: () => void; feedback?: ReactNode;
}) {
  const [busy, setBusy] = useState<'' | 'sign_in' | 'install' | 'recheck' | 'select'>('');
  const [error, setError] = useState('');
  const [announcement, setAnnouncement] = useState('');
  const [confirming, setConfirming] = useState<{ installationId: string; account: string; previous: { name: string; id: string } } | null>(null);
  // The result of Check again, shown even if it could not be stored (for example after a concurrent change).
  const [checked, setChecked] = useState<GithubConnectionDiagnosis | null>(null);
  const summaryRef = useRef<HTMLDivElement>(null);
  const waiting = useRef(false);
  const focused = useRef(false);
  // A diagnosis that disagrees with the connection state (for example right after a disconnect) is stale.
  const stored = checked && checked.revision === data.github.revision && (!data.github_diagnosis || checked.checked_at >= data.github_diagnosis.checked_at)
    ? checked : data.github_diagnosis;
  const fresh = stored && (stored.outcome === 'unavailable' || (data.github.status === 'connected') === ['connected', 'needs_attention'].includes(stored.outcome));
  const diagnosis = fresh ? stored : fallbackDiagnosis(data);
  const sessionExpired = returned === 'session_expired' && data.github.status !== 'connected';
  const connected = data.github.status === 'connected' && Boolean(data.github.github);
  const renew = connected && data.github.github?.repository_creation_state === 'reconnect_required';
  const notes = sessionExpired ? [] : diagnosis.blockers.filter(isNote);
  const choices = data.github_choices ?? [];
  // A choice that is no longer offered (it expired) must still leave a way forward.
  const stalledChoice = diagnosis.outcome === 'choose' && !choices.length;
  const primaryAction: GithubDiagnosisAction | null = sessionExpired ? SESSION_EXPIRED.action! : renew && !diagnosis.primary_action
    ? { kind: 'sign_in', label: 'Reconnect GitHub' } : stalledChoice ? diagnosis.primary_action ?? SIGN_IN_AGAIN : diagnosis.primary_action;
  const primaryBlocker = sessionExpired ? SESSION_EXPIRED : primaryReason(diagnosis.blockers, diagnosis.installations, primaryAction);
  const outcome: GithubDiagnosisOutcome = sessionExpired ? 'sign_in_required' : diagnosis.outcome;
  const summary = sessionExpired ? SUMMARY[outcome] : nextStepSummary(outcome, diagnosis, primaryAction, primaryBlocker);
  const personal = sessionExpired ? null : personalConnection(diagnosis, primaryAction);
  const unmatchedReturn = returned === 'state_expired';
  const working = disabled || Boolean(busy) || disconnecting;
  const lastCheck = useRef<number | null>(null);
  const autoCheck = (now = Date.now()) => shouldAutoRecheck({ available: data.github_setup.available, connected: data.github.status === 'connected',
    outcome: diagnosis.outcome, attempt: data.github_attempt, returned, working: Boolean(busy) || disconnecting, lastCheck: lastCheck.current, now });
  const hint = returnHint({ connected: data.github.status === 'connected', diagnosis, attempt: data.github_attempt, returned });

  // Coming back from GitHub: move focus to the result in this card and announce it once.
  useEffect(() => {
    if (!returned || focused.current) return;
    focused.current = true;
    // Without a callback result the card checks again first and announces that result instead.
    setAnnouncement(autoCheck() && !freshReturn(returned) ? 'Back from GitHub. Checking GitHub again…'
      : `${summary}${primaryBlocker ? ` ${primaryBlocker.message}` : ''}`);
    requestAnimationFrame(() => { summaryRef.current?.focus({ preventScroll: true }); summaryRef.current?.scrollIntoView({ block: 'center', behavior: 'instant' }); });
  }, [returned]);

  async function recheck(owner?: string) {
    lastCheck.current = Date.now();
    setBusy('recheck'); setError('');
    try {
      const result = await request('/diagnosis', { action: 'recheck', ...(owner ? { owner } : {}) });
      const next: GithubConnectionDiagnosis | undefined = result.diagnosis;
      // Refresh first, so a new choice and its list of accounts appear together.
      try { await onRefresh(); } finally { setChecked(next ?? null); }
      setAnnouncement(next ? `Checked again. ${nextStepSummary(next.outcome, next, next.primary_action, primaryReason(next.blockers, next.installations, next.primary_action))}` : 'Checked again.');
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not check GitHub again.'); }
    finally { setBusy(''); }
  }
  // Back from GitHub without a callback (reload, or an App without a Setup URL): check once on page load.
  const loaded = useRef(false);
  useEffect(() => {
    if (loaded.current || !data.github_attempt) return;
    loaded.current = true;
    if (!freshReturn(returned) && autoCheck()) void recheck();
  }, [data.github_attempt]);
  // After a fix opened on GitHub, or while the person may still be finishing there, check again when they return to this tab.
  useEffect(() => {
    const returnedToTab = () => {
      if (document.visibilityState !== 'visible' || busy) return;
      if (waiting.current) { waiting.current = false; void recheck(); return; }
      // Focus and visibilitychange both fire on one return; the interval keeps it to one check.
      if (autoCheck()) void recheck();
    };
    window.addEventListener('focus', returnedToTab); document.addEventListener('visibilitychange', returnedToTab);
    return () => { window.removeEventListener('focus', returnedToTab); document.removeEventListener('visibilitychange', returnedToTab); };
  });

  async function navigate(kind: 'sign_in' | 'install') {
    setBusy(kind); setError(''); setChecked(null);
    try {
      const result = await request('', kind === 'install' ? { action: 'install' } : {});
      if (result.authorization_url) { window.location.assign(result.authorization_url); return; }
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not open GitHub.'); }
    setBusy('');
  }
  async function select(installationId: string, confirmAccountChange?: string) {
    setBusy('select'); setError(''); setChecked(null);
    try {
      await request('', { installation_id: installationId, ...(confirmAccountChange ? { confirm_account_change: confirmAccountChange } : {}) });
      setConfirming(null);
      await onRefresh();
      setAnnouncement('GitHub connected. Setup is complete. This account is reused for your sites.');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not connect the selected account.');
      await onRefresh().catch(() => undefined);
    } finally { setBusy(''); }
  }
  function run(action: GithubDiagnosisAction) {
    if (action.kind === 'sign_in' || action.kind === 'switch_account') return void navigate('sign_in');
    if (action.kind === 'install') return void navigate('install');
    if (action.kind === 'retry') return void recheck();
    if (action.kind === 'confirm_account_change') {
      const row = diagnosis.installations.find(item => item.installation_id === action.installation_id);
      const previous = row?.blockers.find(blocker => blocker.previous_account)?.previous_account;
      if (row && previous) setConfirming({ installationId: row.installation_id, account: accountName(row.account),
        previous: { name: accountName({ login: previous.login, type: previous.type ?? 'Organization' }), id: previous.id } });
    }
  }
  function actionControl(action: GithubDiagnosisAction, primary = false) {
    const className = primary ? 'btn' : 'btn btn--secondary';
    if ((action.kind === 'link' || action.kind === 'contact_publisher') && action.url) {
      return <a className={className} href={action.url} target="_blank" rel="noopener noreferrer" onClick={() => { waiting.current = action.kind === 'link'; }}>
        {action.label} <ExternalLink size={16} aria-hidden="true" /><span className="github-connection__visually-hidden"> (opens in a new tab)</span></a>;
    }
    const pending = (action.kind === 'retry' && busy === 'recheck') || (['sign_in', 'switch_account'].includes(action.kind) && busy === 'sign_in') || (action.kind === 'install' && busy === 'install');
    return <button type="button" className={className} disabled={working} onClick={() => run(action)}>{pending ? 'Opening…' : action.label}</button>;
  }

  const setup = data.github_setup;
  const publisherBlocker = [...diagnosis.blockers, ...diagnosis.installations.flatMap(item => item.blockers)].find(blocker => blocker.who === 'publisher' && ['publisher_app_misconfigured', 'encryption_unavailable'].includes(blocker.code));
  const signedIn = Boolean(diagnosis.github_user) && !sessionExpired;
  const usable = diagnosis.installations.some(item => item.usable);
  const accessCodes = ['repository_selection_limited', 'permissions_update_pending', 'permissions_missing', 'installation_suspended', 'membership_unverifiable'];
  const accessBlocked = diagnosis.installations.some(item => item.blockers.some(blocker => accessCodes.includes(blocker.code)));
  const cardState: PublishingState = disconnecting ? 'waiting' : outcome === 'connected' ? (renew ? 'waiting' : 'ready')
    : ['waiting_on_owner', 'choose', 'needs_attention'].includes(outcome) ? 'waiting' : 'error';
  const owner = data.github.github?.owner;
  const status = disconnecting ? 'Disconnecting…' : outcome === 'connected' ? `Connected · ${owner ?? 'GitHub'}` : outcome === 'needs_attention' ? `Connected · ${owner ?? 'GitHub'} · Needs attention` : STATUS[outcome];
  const ordinaryChoices = choices.filter(choice => !choice.account_change);

  return <PublishingCard id="github" title="GitHub account" state={cardState} status={status}>
    <p>Stores a private repository for each site and its version branches.</p>
    <div ref={summaryRef} tabIndex={-1} className="github-connection__next" data-outcome={outcome} aria-labelledby="github-next-title">
      <h3 id="github-next-title">{outcome === 'connected' ? 'GitHub is ready' : outcome === 'choose' ? 'Next: choose an account' : 'Next step'}</h3>
      <p data-github-summary>{summary}</p>
      {hint && <p className="github-connection__hint" data-github-return-hint>{hint}</p>}
      {unmatchedReturn && <Reason blocker={{ who: 'you', message: UNMATCHED_RETURN }} />}
      {/* On a working connection only the person's own failed step is explained here. */}
      {primaryBlocker && (outcome !== 'connected' || diagnosis.blockers.includes(primaryBlocker)) && <Reason blocker={primaryBlocker} />}
      <div className="github-connection__actions">
        {primaryAction && (outcome !== 'choose' || stalledChoice) && actionControl(primaryAction, true)}
        {setup.available && !connected && primaryAction?.kind !== 'retry' && <button type="button" className="btn btn--secondary" disabled={working} onClick={() => void recheck()}>{busy === 'recheck' ? 'Checking GitHub…' : 'Check again'}</button>}
      </div>
      {personal && <p className="muted" data-github-primary-hint>{CONFIRM_ONCE}</p>}
      {notes.map(note => <div key={note.code} className="github-connection__note" data-github-note={note.code}>
        <Reason blocker={note} />
        {note.action && <div className="github-connection__actions">{actionControl(note.action)}</div>}
      </div>)}
      <p className="github-connection__visually-hidden" data-github-announcement aria-live="polite" aria-atomic="true">{announcement}</p>
      {error && <p role="alert" className="github-connection__error">{error}</p>}
    </div>

    {confirming && <div className="github-connection__confirm" role="group" aria-labelledby="github-confirm-title">
      <h3 id="github-confirm-title">Connect {confirming.account} instead of {confirming.previous.name}?</h3>
      <p>This organization previously published with <strong>{confirming.previous.name}</strong>. New repositories will be created in <strong>{confirming.account}</strong>. Existing repositories stay in {confirming.previous.name} and are not moved. Sites that already publish from {confirming.previous.name} may need to be set up again.</p>
      <div className="github-connection__actions">
        <button type="button" className="btn" disabled={working} onClick={() => void select(confirming.installationId, confirming.previous.id)}>{busy === 'select' ? 'Connecting…' : `Connect ${confirming.account}`}</button>
        <button type="button" className="btn btn--secondary" disabled={working} onClick={() => setConfirming(null)}>Cancel</button>
      </div>
    </div>}

    <ol className="publishing-setup-steps" aria-label="GitHub connection steps">
      <Step id="publisher" title="1. Publisher ready" state={setup.available ? 'ready' : 'error'}
        status={setup.available ? `Ready · GitHub App ${setup.app_slug ?? diagnosis.app.slug ?? ''}`.trim() : setup.app_configured === false ? 'Publisher must configure its GitHub App' : 'Publisher must configure encrypted credential storage'}>
        {!setup.available && <p>{publisherBlocker?.message ?? 'The publisher needs to configure its GitHub App before you can connect.'}</p>}
      </Step>
      <Step id="sign-in" title="2. Sign in to GitHub" state={disconnecting ? 'waiting' : renew ? 'error' : signedIn || connected ? 'ready' : setup.available ? 'error' : 'waiting'}
        status={disconnecting ? 'Disconnecting…' : renew ? 'Action required · Renew authorization' : signedIn ? `Signed in as @${diagnosis.github_user!.login}` : connected ? 'Verified when GitHub was connected' : setup.available ? 'Required · Sign in and approve access' : 'Waiting for the publisher'}>
        {/* Signing in is always possible before a connection exists, unless it is already the primary action. */}
        {setup.available && (signedIn || renew || (!connected && !['sign_in', 'switch_account'].includes(primaryAction?.kind ?? ''))) && <div className="github-connection__actions">
          <button type="button" className="btn btn--secondary" disabled={working} onClick={() => void navigate('sign_in')}>{renew ? 'Reconnect GitHub' : signedIn ? 'Use a different GitHub account' : 'Sign in to GitHub'}</button>
        </div>}
        {connected && data.github.github?.account_type === 'User' && <details open={renew}><summary>Personal account authorization</summary>
          <p>Typeroll securely stores and renews your authorization when creating repositories. If you revoke access or leave it unused for six months, reconnect here. Existing repositories are kept.</p>
        </details>}
      </Step>
      <Step id="installation" title="3. Account with the GitHub App" state={connected || usable ? 'ready' : outcome === 'waiting_on_owner' ? 'waiting' : signedIn ? 'error' : 'waiting'}
        status={connected ? `Ready · ${owner}` : outcome === 'waiting_on_owner' ? 'Waiting for an organization owner to approve the installation'
          : diagnosis.installations.length ? `${diagnosis.installations.length} ${diagnosis.installations.length === 1 ? 'account has' : 'accounts have'} the App` : signedIn ? 'Not installed on an account you own' : 'Waiting for sign-in'}>
        {diagnosis.installations.length > 0 && <ul className="github-connection__accounts" aria-label="Accounts with the GitHub App">
          {diagnosis.installations.map(item => <li key={item.installation_id || item.account.login} data-installation={item.installation_id} data-usable={item.usable}>
            <div className="github-connection__account">
              <strong>{accountName(item.account)}</strong>
              <span className="muted">{item.account.type === 'User' ? 'Personal account' : 'Organization'}</span>
              <span className={`github-connection__badge github-connection__badge--${item.usable ? 'ready' : 'blocked'}`}>{item.usable ? (connected && owner === item.account.login ? 'Connected' : 'Can be connected') : 'Cannot be connected yet'}</span>
            </div>
            {item.blockers.length > 0 && <ul className="github-connection__reasons">
              {item.blockers.map(blocker => <li key={blocker.code}>
                <Reason blocker={blocker} />
                {blocker.action && <div className="github-connection__actions">{actionControl(blocker.action)}</div>}
              </li>)}
            </ul>}
          </li>)}
        </ul>}
        {ordinaryChoices.length > 0 && <form className="stack" onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          const value = String(new FormData(event.currentTarget).get('installation_id') ?? '');
          if (value) void select(value);
        }}>
          <div className="field"><label htmlFor="github-organization">Choose a GitHub account</label>
            <select id="github-organization" name="installation_id" required defaultValue={ordinaryChoices.length === 1 ? ordinaryChoices[0].installation_id : ''}>
              {ordinaryChoices.length > 1 && <option value="" disabled>Select an account</option>}
              {ordinaryChoices.map(choice => <option key={choice.installation_id} value={choice.installation_id}>{choice.owner} — {choice.account_type === 'User' ? 'Personal account' : 'Organization'}</option>)}
            </select></div>
          <button className="btn" disabled={working} type="submit">{busy === 'select' ? 'Connecting…' : 'Connect selected account'}</button>
        </form>}
        {setup.available && !connected && <details>
          <summary>Installed the App on another organization?</summary>
          <form className="stack" onSubmit={(event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            const value = String(new FormData(event.currentTarget).get('owner') ?? '').trim();
            if (value) void recheck(value);
          }}>
            <div className="field"><label htmlFor="github-owner-check">GitHub organization name</label>
              <input id="github-owner-check" name="owner" required maxLength={39} pattern="[A-Za-z0-9](?:[A-Za-z0-9\-]{0,37}[A-Za-z0-9])?" autoComplete="off" /></div>
            <button className="btn btn--secondary" disabled={working} type="submit">Check this organization</button>
          </form>
          <p className="muted">Typeroll checks with the App’s own access and the GitHub account you signed in with during the last hour. Otherwise, sign in again.</p>
        </details>}
      </Step>
      <Step id="access" title="4. Access & permissions" state={connected ? (outcome === 'needs_attention' ? 'error' : 'ready') : accessBlocked ? 'error' : usable ? 'ready' : 'waiting'}
        status={connected ? (outcome === 'needs_attention' ? 'Action required · See the account above' : `Repository access verified for ${owner}`) : accessBlocked ? 'Action required · See the account above' : usable ? 'All repositories, Administration and Contents access granted' : 'Checked after the App is installed'}>
        {connected && <PublishingGithubPermissions revision={data.github.revision} />}
      </Step>
      <Step id="connected" title="5. Connected" state={connected ? 'ready' : 'waiting'} status={connected ? `Connected · ${owner}` : 'Not connected yet'} />
    </ol>
    <details><summary>GitHub setup instructions</summary>
      <ol>
        <li>Select <strong>Connect GitHub</strong> and sign in with your personal account or as an owner of the organization that will own your site repositories.</li>
        <li>If asked, install the App on that account with <strong>All repositories</strong> access and approve the requested permissions.</li>
        <li>Typeroll verifies access and shows every account it found with the reason it can or cannot be used. Fix the reason with the button beside it, then select <strong>Check again</strong>.</li>
      </ol>
    </details>
    {connected && <button className="btn btn--secondary" disabled={working} onClick={onDisconnect}>{disconnecting ? 'Disconnecting…' : 'Disconnect GitHub'}</button>}
    {feedback}
  </PublishingCard>;
}
