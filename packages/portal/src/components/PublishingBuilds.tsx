import { useEffect, useState } from 'react';
import PublishingCard from './PublishingCard';
import type { BuildEngine } from '../lib/builds/cloudflare';

export default function PublishingBuilds() {
  const [engine, setEngine] = useState<BuildEngine | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  async function load() {
    try {
      const response = await fetch('/api/orgs/publishing/builds');
      const value = await response.json();
      if (!response.ok) throw Error(value.error || 'Could not read build settings.');
      setEngine(value);
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not read build settings.'); }
  }
  useEffect(() => { void load(); }, []);
  async function check() {
    if (!engine) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const response = await fetch('/api/orgs/publishing/builds', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: engine.revision }) });
      const value = await response.json();
      if (!response.ok) throw Error(value.error || 'Could not check build access.');
      setEngine(value); setNotice(value.issue?.message || 'Build access checked.');
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not check build access.'); }
    finally { setBusy(false); }
  }
  async function approve() {
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/orgs/publishing/cloudflare', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'start', build_access: true }) });
      const value = await response.json();
      if (!response.ok) throw Error(value.error || 'Could not start build permission approval.');
      const url = new URL(value.authorization_url);
      if (url.origin !== 'https://dash.cloudflare.com' || url.pathname !== '/oauth2/auth') throw Error('Unexpected Cloudflare authorization address.');
      window.location.assign(url.href);
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not start permission approval.'); setBusy(false); }
  }
  const state = engine?.state;
  return <PublishingCard id="publishing-builds" title="Builds"
    state={state === 'ready' ? 'ready' : error || ['approval_required', 'error'].includes(state ?? '') ? 'error' : 'waiting'}
    status={busy ? 'Checking Cloudflare build access…' : state === 'ready' ? 'Shared build engine ready' : state === 'approval_required' ? 'Build permissions required' : state === 'qualification_required' ? 'Build engine verification required' : state === 'build_token_required' ? 'Cloudflare build token required' : 'Shared build engine setup'}>
    <p>One Cloudflare build engine for all sites and versions in this organization. Finished sites can be hosted in any Hosting Group.</p>
    {engine?.account_name && <p>Build account: <strong>{engine.account_name}</strong></p>}
    {state !== 'ready' && <p className="muted">The shared engine is not active yet. Existing publishing settings continue to apply.</p>}
    <button className="btn btn--secondary" disabled={busy || !engine} onClick={() => void check()}>{busy ? 'Checking…' : 'Check build access'}</button>
    {state === 'approval_required' && <button className="btn" disabled={busy} onClick={() => void approve()}>Approve build permissions</button>}
    {error && <p role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {!notice && engine?.issue && <p>{engine.issue.message}</p>}
    <details><summary>How organization builds work</summary>
      <p>GitHub stores each site's generated source. Cloudflare builds it using this organization's shared engine. The site's Hosting Group receives the static files. Adding sites or Hosting Groups does not require another GitHub installation.</p>
      <p>Build permission approval applies to the existing organization Cloudflare connection. It does not disconnect your media or hosting accounts.</p>
    </details>
  </PublishingCard>;
}
