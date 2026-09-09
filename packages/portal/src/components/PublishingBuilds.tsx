import { useEffect, useRef, useState } from 'react';
import { Copy, ExternalLink } from 'lucide-react';
import PublishingCard from './PublishingCard';
import type { BuildEngine } from '../lib/builds/cloudflare';
import type { BuildProvider } from '../lib/builds/state';
import type { readBuildSettings } from '../lib/builds/selection';
type BuildSettings = Awaited<ReturnType<typeof readBuildSettings>>;
import './PublishingBuilds.css';

export default function PublishingBuilds() {
  const [engine, setEngine] = useState<BuildEngine | null>(null);
  const [settings, setSettings] = useState<BuildSettings | null>(null);
  const viewing = useRef<BuildProvider | null>(null);
  function adopt(value: BuildSettings | BuildEngine, provider?: BuildProvider) {
    if ('engines' in value) { setSettings(value); viewing.current = provider ?? viewing.current ?? value.selection.provider; setEngine(value.engines[viewing.current]); }
    else setEngine(value);
  }
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const inFlight = useRef(false), awaitingReturn = useRef(false);
  async function load() {
    try {
      const response = await fetch('/api/orgs/publishing/builds');
      const value = await response.json();
      if (!response.ok) throw Error(value.error || 'Could not read build settings.');
      adopt(value);
      // Refresh older setup records and permissions after the OAuth return.
      if ((value.state === 'build_token_required' && value.worker_found === undefined) || new URLSearchParams(window.location.search).get('cloudflare') === 'connected') await check(value);
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not read build settings.'); }
  }
  useEffect(() => { void load(); }, []);
  useEffect(() => {
    if (engine?.issue?.code !== 'build_verification_running' && !settings?.active_jobs.length) return;
    const timer = window.setInterval(() => { if (!inFlight.current && document.visibilityState === 'visible') void (engine?.issue?.code === 'build_verification_running' ? check() : load()); }, 15000);
    return () => window.clearInterval(timer);
  }, [engine, settings]);
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
      const response = await fetch('/api/orgs/publishing/builds', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: current.revision, ...(current.provider === 'github' ? { provider: 'github' } : {}) }) });
      const value = await response.json();
      if (!response.ok) throw Error(value.error || 'Could not check build setup.');
      adopt(value, current.provider); setNotice(value.engines?.[current.provider]?.issue?.message || value.issue?.message || 'Build setup checked.');
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
  async function setup() {
    if (!engine || inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(''); setNotice('Preparing the shared build engine…');
    try {
      const response = await fetch('/api/orgs/publishing/builds', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'setup', revision: engine.revision, ...(engine.provider === 'github' ? { provider: 'github' } : {}) }) });
      const value = await response.json();
      if (!response.ok) throw Error(value.error || 'Could not set up shared builds.');
      adopt(value, engine.provider); setNotice(value.engines?.[engine.provider]?.issue?.message || value.issue?.message || 'Build engine checked.');
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not set up shared builds.'); }
    finally { inFlight.current = false; setBusy(false); }
  }
  async function manage(action: 'select' | 'cancel', key?: string) {
    if (!settings || !engine || inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(''); setNotice('');
    try {
      const response = await fetch('/api/orgs/publishing/builds', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, provider: engine.provider, revision: settings.selection.revision, ...(key ? { key } : {}) }) });
      const value = await response.json();
      if (!response.ok) throw Error(value.error || 'Could not update build settings.');
      adopt(value, engine.provider);
      setNotice(action === 'cancel' ? 'Build cancelled. It cannot publish a site.' : `Saved. New publications will build on ${engine.provider === 'github' ? 'GitHub Actions' : 'Cloudflare'}. Existing jobs keep their build provider.`);
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not update build settings.'); }
    finally { inFlight.current = false; setBusy(false); }
  }
  async function copy(value: string, label: string) {
    try { await navigator.clipboard.writeText(value); setNotice(`${label} copied.`); }
    catch { setError(`Could not copy ${label.toLowerCase()}. Select the text and copy it manually.`); }
  }
  const state = engine?.state;
  const github = engine?.provider === 'github';
  const active = !settings || settings.selection.provider === engine?.provider;
  const needsToken = !github && state === 'build_token_required';
  const projectUrl = engine?.worker_found && /^[a-f0-9]{32}$/.test(engine.account_id ?? '') && /^[a-z0-9-]+$/.test(engine.worker_name)
    ? `https://dash.cloudflare.com/${engine.account_id}/workers/services/view/${engine.worker_name}/production/settings` : null;
  const status = busy ? 'Updating build settings…' : state === 'ready' ? 'Shared build engine ready' : state === 'approval_required' ? 'Build permissions required' : state === 'qualification_required' ? engine?.issue?.code === 'build_verification_running' ? 'Verifying shared build engine…' : github ? 'GitHub verification pending' : 'Build token found · Verification pending' : needsToken ? 'Action needed · Create a build token' : 'Shared build engine setup';
  return <PublishingCard id="publishing-builds" title="Builds"
    state={state === 'ready' ? 'ready' : error || ['approval_required', 'error'].includes(state ?? '') ? 'error' : 'waiting'} status={status}>
    <p>Choose where this organization builds its sites and versions. Finished static files go to each site’s Hosting Group.</p>
    {settings && <>
      <p>New publications use <strong>{settings.selection.provider === 'github' ? 'GitHub Actions' : 'Cloudflare'}</strong>.</p>
      <div className="field"><label htmlFor="build-provider">Build provider</label><select id="build-provider" disabled={busy} value={engine?.provider ?? settings.selection.provider} onChange={event => {
        const provider = event.target.value as BuildProvider; viewing.current = provider; setEngine(settings.engines[provider]); setError(''); setNotice('');
      }}><option value="cloudflare">Cloudflare</option><option value="github">GitHub Actions</option></select></div>
    </>}
    {github && <p>Build minutes count toward this GitHub organization’s Actions allowance. Media stays in the organization’s R2 storage.</p>}
    {engine?.account_name && <p>Build account: <strong>{engine.account_name}</strong></p>}
    {state !== 'ready' && <p className="muted">Complete setup and verification before publishing with the shared engine.</p>}
    {state === 'ready' && <p>{active ? 'Shared builds are active. New publications build in this account and upload static files to the site’s Hosting Group.' : 'This engine is ready. Select it below to use it for new publications.'}</p>}
    {github && state !== 'ready' && <p>Set up once for this organization. Typeroll creates a private build repository and runs a verification build through the existing GitHub connection.</p>}
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
    {engine && state !== 'approval_required' && engine.issue?.code !== 'build_verification_running' && <button className="btn" disabled={busy} onClick={() => void setup()}>{state === 'ready' ? 'Update build engine' : github ? 'Set up GitHub builds' : 'Set up shared builds'}</button>}
    {github && state === 'approval_required' && <a className="btn" href="#github">Review GitHub permissions</a>}
    {!github && state === 'approval_required' && <button className="btn" disabled={busy} onClick={() => void approve()}>Approve build permissions</button>}
    {settings && !active && state === 'ready' && <button className="btn" disabled={busy} onClick={() => void manage('select')}>Use {github ? 'GitHub Actions' : 'Cloudflare'} for new builds</button>}
    {!!settings?.active_jobs.length && <section className="publishing-builds__activity" aria-label="Active builds"><h3>Active builds</h3><ul>{settings.active_jobs.map(job => <li key={job.key}>
      <div><strong>{job.site_name}</strong><span>{job.version_id} · {job.provider === 'github' ? 'GitHub Actions' : 'Cloudflare'} · {job.status === 'running' ? 'Building' : 'Queued'}</span></div>
      {job.provider === 'github' && <button className="btn btn--secondary" disabled={busy} onClick={() => void manage('cancel', job.key)} aria-label={`Cancel build for ${job.site_name}`}>Cancel build</button>}
    </li>)}</ul></section>}
    {error && <p role="alert">{error}</p>}
    {notice && <p role="status" className="publishing-builds__notice">{notice}</p>}
    {!notice && engine?.issue && !needsToken && <p>{engine.issue.message}</p>}
    {!github && <details><summary>Why is this step needed?</summary>
      <p>Cloudflare’s sign-in approval allows Typeroll to manage build settings, but cannot create the first build token. Cloudflare creates that token in its own dashboard. Once it exists, Typeroll can detect it through the existing connection.</p>
      <p>Finding a token confirms this setup step. The shared engine must still finish its setup and verification before it can publish sites.</p>
    </details>}
  </PublishingCard>;
}
