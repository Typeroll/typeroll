import { useEffect, useRef, useState } from 'react';
import { Copy, ExternalLink } from 'lucide-react';
import PublishingCard from './PublishingCard';
import type { BuildEngine } from '../lib/builds/cloudflare';
import './PublishingBuilds.css';

export default function PublishingBuilds() {
  const [engine, setEngine] = useState<BuildEngine | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const inFlight = useRef(false), awaitingReturn = useRef(false);
  async function load() {
    try {
      const response = await fetch('/api/orgs/publishing/builds');
      const value = await response.json();
      if (!response.ok) throw Error(value.error || 'Could not read build settings.');
      setEngine(value);
      // Refresh older setup records and permissions after the OAuth return.
      if ((value.state === 'build_token_required' && value.worker_found === undefined) || new URLSearchParams(window.location.search).get('cloudflare') === 'connected') await check(value);
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not read build settings.'); }
  }
  useEffect(() => { void load(); }, []);
  useEffect(() => {
    const returned = () => {
      if (awaitingReturn.current && document.visibilityState === 'visible' && !inFlight.current && engine) {
        awaitingReturn.current = false;
        void check(engine);
      }
    };
    window.addEventListener('focus', returned);
    document.addEventListener('visibilitychange', returned);
    return () => { window.removeEventListener('focus', returned); document.removeEventListener('visibilitychange', returned); };
  }, [engine]);
  async function check(current = engine) {
    if (!current || inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(''); setNotice('');
    try {
      const response = await fetch('/api/orgs/publishing/builds', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: current.revision }) });
      const value = await response.json();
      if (!response.ok) throw Error(value.error || 'Could not check build setup.');
      setEngine(value); setNotice(value.issue?.message || 'Build setup checked.');
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not check build setup.'); }
    finally { inFlight.current = false; setBusy(false); }
  }
  async function approve() {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError('');
    try {
      const response = await fetch('/api/orgs/publishing/cloudflare', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'start', build_access: true }) });
      const value = await response.json();
      if (!response.ok) throw Error(value.error || 'Could not start build permission approval.');
      const url = new URL(value.authorization_url);
      if (url.origin !== 'https://dash.cloudflare.com' || url.pathname !== '/oauth2/auth') throw Error('Unexpected Cloudflare authorization address.');
      window.location.assign(url.href);
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not start permission approval.'); inFlight.current = false; setBusy(false); }
  }
  async function copy(value: string, label: string) {
    try { await navigator.clipboard.writeText(value); setNotice(`${label} copied.`); }
    catch { setError(`Could not copy ${label.toLowerCase()}. Select the text and copy it manually.`); }
  }
  const state = engine?.state;
  const needsToken = state === 'build_token_required';
  const projectUrl = engine?.worker_found && /^[a-f0-9]{32}$/.test(engine.account_id ?? '') && /^[a-z0-9-]+$/.test(engine.worker_name)
    ? `https://dash.cloudflare.com/${engine.account_id}/workers/services/view/${engine.worker_name}/production/settings` : null;
  const status = busy ? 'Checking Cloudflare build setup…' : state === 'ready' ? 'Shared build engine ready' : state === 'approval_required' ? 'Build permissions required' : state === 'qualification_required' ? 'Build token found · Verification pending' : needsToken ? 'Action needed · Create a build token' : 'Shared build engine setup';
  return <PublishingCard id="publishing-builds" title="Builds"
    state={state === 'ready' ? 'ready' : error || ['approval_required', 'error'].includes(state ?? '') ? 'error' : 'waiting'} status={status}>
    <p>One Cloudflare build engine for all sites and versions in this organization. Finished sites can be hosted in any Hosting Group.</p>
    {engine?.account_name && <p>Build account: <strong>{engine.account_name}</strong></p>}
    {state !== 'ready' && <p className="muted">The shared engine is not active yet. Existing publishing settings continue to apply.</p>}
    {needsToken && <div className="publishing-builds__setup">
      <h3>One-time setup in Cloudflare</h3>
      <p>Your build permissions are approved. Cloudflare needs a build token before it can run builds. Create it in <strong>{engine?.account_name}</strong>, the organization’s build account.</p>
      {projectUrl ? <>
        <a className="btn" href={projectUrl} target="_blank" rel="noopener noreferrer" onClick={() => { awaitingReturn.current = true; }}>Open Cloudflare setup <ExternalLink size={16} aria-hidden="true" /></a>
        <details>
          <summary>Step-by-step instructions</summary>
          <ol>
            <li>Open the link above. Confirm that the Cloudflare account is <strong>{engine?.account_name}</strong> and the Worker project is <code>{engine?.worker_name}</code>.</li>
            <li>In <strong>Settings → Builds</strong>, select <strong>Connect</strong>. Choose GitHub and the repository <code>{engine?.runner_repo}</code> from your connected GitHub organization. Use branch <code>main</code>.</li>
            <li>Use these commands for the initial connection test:
              <div className="publishing-builds__commands">
                {([['Build command', 'npm run build'], ['Deploy command', 'npm run qualify:artifact']] as const).map(([label, command]) => <div key={label}>
                  <strong>{label}</strong><div><code>{command}</code><button type="button" className="btn btn--secondary" aria-label={`Copy ${label.toLowerCase()}`} onClick={() => void copy(command, label)}><Copy size={16} aria-hidden="true" /> Copy</button></div>
                </div>)}
              </div>
            </li>
            <li>In <strong>API token</strong>, choose <strong>Create new token</strong> if prompted. Save the connection with <strong>Save</strong> or <strong>Save and deploy</strong>. If the repository is already connected, open <strong>Settings → Builds → API token</strong> and create or select a token there.</li>
            <li>Return here. Typeroll checks when you return from the Cloudflare tab. You can also select <strong>I’ve finished — check again</strong> below.</li>
          </ol>
          <p>The connection test creates a small test artifact. It does not publish a customer site. You do not need to configure each site or Hosting Group separately.</p>
          <p>If the repository is missing, check the GitHub organization selected in Cloudflare. If the controls differ, use <a href="https://developers.cloudflare.com/workers/ci-cd/builds/configuration/#api-token" target="_blank" rel="noopener noreferrer">Cloudflare’s build token instructions</a>.</p>
        </details>
      </> : <p>The build project has not been found in this account yet. Its preparation must finish before you can create the token here. Check the setup again after the project has been prepared.</p>}
      <p className="muted">The token stays in Cloudflare. You do not need to paste it into Typeroll or reconnect your Cloudflare account.</p>
    </div>}
    <button className="btn btn--secondary" disabled={busy || !engine} onClick={() => void check()}>{busy ? 'Checking…' : needsToken && projectUrl ? 'I’ve finished — check again' : 'Check build setup'}</button>
    {state === 'approval_required' && <button className="btn" disabled={busy} onClick={() => void approve()}>Approve build permissions</button>}
    {error && <p role="alert">{error}</p>}
    {notice && <p role="status" className="publishing-builds__notice">{notice}</p>}
    {!notice && engine?.issue && !needsToken && <p>{engine.issue.message}</p>}
    <details><summary>Why is this step needed?</summary>
      <p>Cloudflare’s sign-in approval allows Typeroll to manage build settings, but cannot create the first build token. Cloudflare creates that token in its own dashboard. Once it exists, Typeroll can detect it through the existing connection.</p>
      <p>Finding a token confirms this setup step. The shared engine must still finish its setup and verification before it can publish sites.</p>
    </details>
  </PublishingCard>;
}
