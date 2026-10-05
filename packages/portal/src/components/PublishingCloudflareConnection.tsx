import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ExternalLink } from 'lucide-react';
import PublishingSetupStep from './PublishingSetupStep';
import type { PublishingState } from './PublishingCard';
import type {
  CloudflareBlocker, CloudflareConnectionDiagnosis, CloudflareDiagnosisAccount, CloudflareDiagnosisAction,
} from '../lib/publishing/cloudflare-diagnosis';
import {
  CLOUDFLARE_WHO, cloudflareDiagnosisAt, cloudflareNextStep, cloudflarePrimaryReason, fallbackCloudflareDiagnosis, formatTime, SESSION_EXPIRED, UNMATCHED_RETURN,
} from './cloudflare-return';
import './PublishingCloudflareConnection.css';

export type CloudflareConnectionStatus = {
  status: 'connected' | 'disconnected' | string; revision: string;
  cloudflare: { account_id?: string; account_name: string } | null;
};

const API = '/api/orgs/publishing/cloudflare';
const FLOW_SIGN_IN = ['oauth_cancelled', 'state_expired', 'wrong_browser', 'session_expired'];

class CloudflareRequestError extends Error {}
async function request(path: string, body: unknown) {
  const response = await fetch(`${API}${path}`, { method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new CloudflareRequestError(data.error || 'Could not reach Typeroll. Check your connection and try again.');
  return data;
}

/** Who acts, as a label of its own, then the reason as a separate sentence. */
function Reason({ blocker }: { blocker: Pick<CloudflareBlocker, 'who' | 'message' | 'code'> }) {
  return <div className="cloudflare-connection__reason" data-cloudflare-reason={blocker.code}>
    <p><span className="cloudflare-connection__who">Who acts: {CLOUDFLARE_WHO[blocker.who]}</span></p>
    <p>{blocker.message}</p>
  </div>;
}

/** The current time, renewed when an offered account choice closes, so every view of it changes together. */
export function useCloudflareClock(diagnosis: Pick<CloudflareConnectionDiagnosis, 'outcome' | 'selection_expires_at'> | undefined): [number, (value: number) => void] {
  const [now, setNow] = useState(() => Date.now());
  const expires = diagnosis?.outcome === 'choose' ? diagnosis.selection_expires_at : null;
  useEffect(() => {
    if (!expires) return;
    const remaining = Date.parse(expires) - Date.now();
    if (remaining <= 0) { setNow(Date.now()); return; }
    const timer = setTimeout(() => setNow(Date.now()), Math.min(remaining + 50, 2_147_000_000));
    return () => clearTimeout(timer);
  }, [expires]);
  return [now, setNow];
}

/**
 * The connection part of a Cloudflare card for one Hosting Group: the next step with its one primary action,
 * the account chooser when several accounts were authorized, and the steps of the connection.
 */
export default function PublishingCloudflareConnection({ groupId, connection, diagnosis: served, choices = [], available, returned, disabled, onRefresh }: {
  groupId: string; connection: CloudflareConnectionStatus; diagnosis?: CloudflareConnectionDiagnosis; choices?: Array<{ id: string; name: string }>;
  available: boolean;
  /** Value of ?cloudflare= when the person just came back from Cloudflare to this card. */
  returned: string | null;
  disabled?: boolean; onRefresh: () => Promise<unknown>;
}) {
  const [busy, setBusy] = useState<'' | 'sign_in' | 'recheck' | 'select'>('');
  const [error, setError] = useState('');
  const [announcement, setAnnouncement] = useState('');
  const [checked, setChecked] = useState<CloudflareConnectionDiagnosis | null>(null);
  const [selected, setSelected] = useState('');
  const summaryRef = useRef<HTMLDivElement>(null);
  const focused = useRef(false);
  const connected = connection.status === 'connected' && Boolean(connection.cloudflare);
  // A diagnosis that disagrees with the connection state (for example right after a disconnect) is stale.
  const latest = checked && checked.revision === connection.revision && (!served || checked.checked_at >= served.checked_at) ? checked : served;
  const fresh = latest && (latest.outcome === 'unavailable' || connected === ['connected', 'needs_attention'].includes(latest.outcome));
  const base = fresh ? latest : fallbackCloudflareDiagnosis({ groupId, available, connection, choices });
  const [now, setNow] = useCloudflareClock(base);
  const selectable = new Set(choices.map(choice => choice.id));
  const timed = cloudflareDiagnosisAt(base, now);
  // A choice the server no longer offers (it expired or was used elsewhere) must still leave a way forward.
  const diagnosis = timed.outcome === 'choose' && !timed.accounts.concat(choices.map(choice => ({ ...choice, usable: true, blockers: [] })))
    .some(account => account.usable && selectable.has(account.id)) ? cloudflareDiagnosisAt(timed, now, true) : timed;
  const sessionExpired = returned === 'session_expired' && !connected;
  const outcome = sessionExpired ? 'sign_in_required' : diagnosis.outcome;
  const primaryAction: CloudflareDiagnosisAction | null = sessionExpired ? SESSION_EXPIRED.action! : diagnosis.primary_action;
  const primaryBlocker = sessionExpired ? SESSION_EXPIRED : cloudflarePrimaryReason(diagnosis, primaryAction);
  const summary = sessionExpired ? 'Cloudflare is not connected. Sign in again to continue.' : cloudflareNextStep(diagnosis, primaryAction, primaryBlocker);
  const working = Boolean(disabled) || Boolean(busy);
  const offered: CloudflareDiagnosisAccount[] = diagnosis.accounts.length ? diagnosis.accounts : choices.map(choice => ({ ...choice, usable: true, blockers: [] }));
  const choosing = outcome === 'choose' && offered.some(account => account.usable && selectable.has(account.id));
  const usableChoices = offered.filter(account => account.usable && selectable.has(account.id));
  const chosen = selected && usableChoices.some(account => account.id === selected) ? selected : usableChoices.length === 1 ? usableChoices[0].id : '';
  const expiresAt = formatTime(diagnosis.selection_expires_at);

  // Coming back from Cloudflare: move focus to the result in this card and announce it once.
  useEffect(() => {
    if (!returned || focused.current) return;
    focused.current = true;
    setAnnouncement(`${summary}${primaryBlocker ? ` ${primaryBlocker.message}` : ''}`);
    requestAnimationFrame(() => { summaryRef.current?.focus({ preventScroll: true }); summaryRef.current?.scrollIntoView({ block: 'center', behavior: 'instant' }); });
  }, [returned]);

  async function signIn() {
    setBusy('sign_in'); setError(''); setChecked(null);
    try {
      const result = await request('', { action: 'start', ...(groupId === 'default' ? {} : { hosting_group_id: groupId }) });
      if (result.authorization_url) { window.location.assign(result.authorization_url); return; }
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not open Cloudflare.'); }
    setBusy('');
  }
  async function recheck() {
    setBusy('recheck'); setError('');
    try {
      const result = await request('/diagnosis', { action: 'recheck', hosting_group_id: groupId });
      const next: CloudflareConnectionDiagnosis | undefined = result.diagnosis;
      // Refresh first, so a new choice and its accounts appear together.
      try { await onRefresh(); } finally { setChecked(next ?? null); setNow(Date.now()); }
      setAnnouncement(next ? `Checked again. ${cloudflareNextStep(next, next.primary_action, cloudflarePrimaryReason(next, next.primary_action))}` : 'Checked again.');
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not check Cloudflare again.'); }
    finally { setBusy(''); }
  }
  async function select(accountId: string) {
    setBusy('select'); setError(''); setChecked(null);
    try {
      await request('', { action: 'select', account_id: accountId, ...(groupId === 'default' ? {} : { hosting_group_id: groupId }) });
      await onRefresh();
      setAnnouncement('Cloudflare connected. This account is reused for this organization’s sites.');
    } catch (failure) {
      // The stored diagnosis explains the reason in the card; keep the server's sentence for screen readers too.
      setAnnouncement(failure instanceof Error ? failure.message : 'Could not connect the selected account.');
      await onRefresh().catch(() => setError('Could not connect the selected account. Reload the page to see why.'));
    } finally { setBusy(''); }
  }
  function actionControl(action: CloudflareDiagnosisAction, primary = false): ReactNode {
    const className = primary ? 'btn' : 'btn btn--secondary';
    if ((action.kind === 'link' || action.kind === 'contact_publisher') && action.url) {
      return <a className={className} href={action.url} target="_blank" rel="noopener noreferrer">
        {action.label} <ExternalLink size={16} aria-hidden="true" /><span className="cloudflare-connection__visually-hidden"> (opens in a new tab)</span></a>;
    }
    const pending = (action.kind === 'retry' && busy === 'recheck') || (action.kind === 'sign_in' && busy === 'sign_in');
    return <button type="button" className={className} disabled={working || !available} onClick={() => void (action.kind === 'retry' ? recheck() : signIn())}>
      {pending ? (action.kind === 'retry' ? 'Checking Cloudflare…' : 'Opening Cloudflare…') : action.label}</button>;
  }

  const allBlockers = [...diagnosis.blockers, ...diagnosis.accounts.flatMap(item => item.blockers)];
  const signInFailed = !sessionExpired && diagnosis.blockers.find(blocker => FLOW_SIGN_IN.includes(blocker.code));
  const consented = !connected && diagnosis.accounts.length > 0;
  const savedName = connection.cloudflare?.account_name ?? 'Cloudflare';
  const accessBlocked = allBlockers.some(blocker => ['pages_access_denied', 'permissions_missing', 'authorization_revoked', 'claimed_by_other_organization'].includes(blocker.code));
  const choiceExpired = allBlockers.some(blocker => blocker.code === 'account_choice_expired');
  const showRows = !choosing && diagnosis.accounts.length > 0 && !(connected && diagnosis.accounts.length === 1 && diagnosis.accounts[0].usable);
  // While choosing, connecting the chosen account is the one action.
  const secondarySignIn = available && !connected && !choosing && primaryAction?.kind !== 'sign_in' && outcome !== 'unavailable';
  const showRecheck = available && diagnosis.recheck_available && !choosing && primaryAction?.kind !== 'retry' && !sessionExpired;
  const step = (id: string, title: string, state: PublishingState, status: string, children?: ReactNode) =>
    <PublishingSetupStep provider="cloudflare" id={groupId === 'default' ? id : `${groupId}-${id}`} title={title} state={state} status={status}>{children}</PublishingSetupStep>;

  return <div className="cloudflare-connection" data-hosting-group={groupId}>
    <div ref={summaryRef} tabIndex={-1} className="cloudflare-connection__next" data-outcome={outcome} aria-labelledby={`cloudflare-next-${groupId}`}>
      <h3 id={`cloudflare-next-${groupId}`}>{outcome === 'connected' ? 'Cloudflare is ready' : choosing ? 'Next: choose an account'
        : outcome === 'sign_in_pending' ? 'Waiting for Cloudflare' : 'Next step'}</h3>
      <p data-cloudflare-summary>{summary}</p>
      {returned === 'state_expired' && !connected && <Reason blocker={{ code: 'state_expired', who: 'you', message: UNMATCHED_RETURN }} />}
      {outcome === 'sign_in_pending' && diagnosis.sign_in_started_at && <p className="muted">You started signing in at {formatTime(diagnosis.sign_in_started_at)}. If you closed Cloudflare’s page or it showed an error, start again.</p>}
      {/* On a working connection only the person's own failed step or a re-check finding is explained here. */}
      {primaryBlocker && !choosing && (outcome !== 'connected' || diagnosis.blockers.includes(primaryBlocker)) && <Reason blocker={primaryBlocker} />}
      {choosing && <form className="cloudflare-connection__choice" onSubmit={(event: FormEvent<HTMLFormElement>) => { event.preventDefault(); if (chosen) void select(chosen); }}>
        <fieldset>
          <legend>Choose a Cloudflare account</legend>
          <p className="muted">You authorized {offered.length} accounts on Cloudflare. Typeroll does not pick one for you: the account you choose hosts this organization’s sites and stays reserved for this organization, and reconnecting later must use the same account.</p>
          {expiresAt && <p data-cloudflare-expiry>Choose by {expiresAt}. After that, check again or connect Cloudflare again.</p>}
          <ul className="cloudflare-connection__accounts" aria-label="Authorized Cloudflare accounts">
            {offered.map(account => {
              const enabled = account.usable && selectable.has(account.id);
              return <li key={account.id} data-account={account.id} data-usable={enabled}>
                <label className="cloudflare-connection__account">
                  <input type="radio" name={`cloudflare-account-${groupId}`} value={account.id} disabled={!enabled || working} checked={chosen === account.id} onChange={() => setSelected(account.id)} />
                  <strong>{account.name}</strong>
                  <span className={`cloudflare-connection__badge cloudflare-connection__badge--${enabled ? 'ready' : 'blocked'}`}>{enabled ? 'Pages access verified' : 'Cannot be connected'}</span>
                </label>
                {account.blockers.length > 0 && <ul className="cloudflare-connection__reasons">{account.blockers.map(blocker => <li key={blocker.code}>
                  <Reason blocker={blocker} />
                  {blocker.action && <div className="cloudflare-connection__actions">{actionControl(blocker.action)}</div>}
                </li>)}</ul>}
              </li>;
            })}
          </ul>
        </fieldset>
        <div className="cloudflare-connection__actions">
          <button type="submit" className="btn" disabled={working || !chosen}>{busy === 'select' ? 'Connecting…'
            : chosen ? `Connect ${offered.find(account => account.id === chosen)?.name ?? 'selected account'}` : 'Select an account to connect'}</button>
        </div>
      </form>}
      <div className="cloudflare-connection__actions">
        {primaryAction && !choosing && actionControl(primaryAction, true)}
        {showRecheck && <button type="button" className="btn btn--secondary" disabled={working} onClick={() => void recheck()}>{busy === 'recheck' ? 'Checking Cloudflare…' : 'Check again'}</button>}
        {secondarySignIn && <button type="button" className="btn btn--secondary" disabled={working} onClick={() => void signIn()}>{busy === 'sign_in' ? 'Opening Cloudflare…' : 'Connect Cloudflare again'}</button>}
      </div>
      <p className="cloudflare-connection__visually-hidden" data-cloudflare-announcement aria-live="polite" aria-atomic="true">{announcement}</p>
      {error && <p role="alert" className="cloudflare-connection__error">{error}</p>}
    </div>

    <ol className="publishing-setup-steps" aria-label="Cloudflare connection steps">
      {step('publisher', '1. Publisher ready', available ? 'ready' : 'error', available ? 'Ready · Cloudflare sign-in is configured' : 'Publisher must configure Cloudflare sign-in')}
      {step('sign-in', '2. Sign in to Cloudflare',
        connected || consented ? 'ready' : outcome === 'sign_in_pending' ? 'waiting' : available ? 'error' : 'waiting',
        connected ? 'Verified when Cloudflare was connected' : consented ? `Signed in · ${diagnosis.accounts.length} ${diagnosis.accounts.length === 1 ? 'account' : 'accounts'} authorized`
          : outcome === 'sign_in_pending' ? `Waiting for Cloudflare since ${formatTime(diagnosis.sign_in_started_at)}` : signInFailed ? 'Not completed · See the reason above'
          : available ? 'Required · Sign in and approve access' : 'Waiting for the publisher')}
      {step('account', '3. Choose account',
        connected ? 'ready' : choosing ? 'waiting' : choiceExpired || allBlockers.some(blocker => ['locked_to_account', 'no_eligible_account', 'too_many_accounts'].includes(blocker.code)) ? 'error'
          : diagnosis.accounts.length === 1 ? 'ready' : 'waiting',
        connected ? `Connected · ${savedName}` : choosing ? `Choose one of ${offered.length} accounts${expiresAt ? ` by ${expiresAt}` : ''}`
          : choiceExpired ? `Choice expired${diagnosis.selection_expires_at ? ` at ${formatTime(diagnosis.selection_expires_at)}` : ''}`
          : allBlockers.some(blocker => blocker.code === 'locked_to_account') ? 'Action required · Use the original account'
          : allBlockers.some(blocker => ['no_eligible_account', 'too_many_accounts'].includes(blocker.code)) ? 'Action required · See the reason above'
          : diagnosis.accounts.length === 1 ? `Only ${diagnosis.accounts[0].name} was authorized` : 'Waiting for sign-in',
        showRows && <ul className="cloudflare-connection__accounts" aria-label="Authorized Cloudflare accounts">
          {diagnosis.accounts.map(account => <li key={account.id} data-account={account.id} data-usable={account.usable}>
            <div className="cloudflare-connection__account">
              <strong>{account.name}</strong>
              <span className={`cloudflare-connection__badge cloudflare-connection__badge--${account.usable ? 'ready' : 'blocked'}`}>{account.usable ? (connected && account.id === connection.cloudflare?.account_id ? 'Connected' : 'Can be connected') : 'Cannot be connected yet'}</span>
            </div>
            {account.blockers.length > 0 && <ul className="cloudflare-connection__reasons">{account.blockers.map(blocker => <li key={blocker.code}>
              <Reason blocker={blocker} />
              {blocker.action && <div className="cloudflare-connection__actions">{actionControl(blocker.action)}</div>}
            </li>)}</ul>}
          </li>)}
        </ul>)}
      {step('access', '4. Access verified',
        accessBlocked ? 'error' : connected || diagnosis.accounts.some(account => account.usable) ? 'ready' : 'waiting',
        accessBlocked ? 'Action required · See the reason above' : connected ? `Cloudflare Pages access verified for ${savedName}`
          : diagnosis.accounts.some(account => account.usable) ? 'Cloudflare Pages access verified' : 'Checked after you sign in')}
      {step('connected', '5. Connected', connected ? (outcome === 'needs_attention' ? 'error' : 'ready') : 'waiting',
        connected ? (outcome === 'needs_attention' ? `Connected · ${savedName} · Needs attention` : `Connected · ${savedName}`) : 'Not connected yet')}
    </ol>
  </div>;
}
