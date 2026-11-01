import PublishingDomainOnboarding from './PublishingDomainOnboarding';
import { useEffect, useState } from 'react';

type Guide = { previous_hosts?: Array<{ host: string; target_host: string; mode: 'redirect' | 'noindex'; status: string; message: string }>; title: string; revision: string; state: string; current_phase: string; traffic_live: boolean; next_action: string; can_prepare?: boolean; published_main?: boolean; elapsed_seconds?: number | null; candidate?: { id: string }; cutover?: { state: string; errors: string[] } | null; checks: Array<{ id: string; status: string; message: string }>;
  preparation?: { validation_blocker?: { resolution: string } }; switch_summary: { interruption: string; rollback: string; validation_timeout_minutes: number }; };

/** A single visible journey; polling only refreshes status and never advances a traffic action. */
export default function PublishingDomainGuide({ siteId }: { siteId: string }) {
  const endpoint = `/api/sites/${encodeURIComponent(siteId)}/publishing/domain-guide`;
  const [guide, setGuide] = useState<Guide | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false), [notice, setNotice] = useState('');
  const [review, setReview] = useState(false), [accept, setAccept] = useState(false);
  async function load() {
    const response = await fetch(endpoint, { cache: 'no-store' }), body = await response.json();
    if (!response.ok) throw new Error(body.error || 'Could not check domain migration.');
    if (!Array.isArray(body.checks)) throw new Error('The domain checklist could not be loaded. Reload and try again.');
    setGuide(body);
  }
  useEffect(() => { let cancelled = false; void load().catch(err => { if (!cancelled) setError(err.message); }); return () => { cancelled = true; }; }, [endpoint]);
  useEffect(() => {
    const changed = () => { void load().catch(err => setError(err.message)); };
    window.addEventListener('typeroll:site-domains-changed', changed);
    return () => window.removeEventListener('typeroll:site-domains-changed', changed);
  }, [endpoint]);
  useEffect(() => {
    if (!guide || !['preparing', 'distributing'].includes(guide.state)) return;
    const timer = setInterval(() => { void load().catch(err => setError(err.message)); }, 15000);
    return () => clearInterval(timer);
  }, [endpoint, guide?.state]);
  async function action(action: string, extra: Record<string, unknown> = {}) {
    if (!guide) return;
    setBusy(true); setError(''); setNotice('');
    try {
      let result: { reused_candidate?: boolean; already_running?: boolean } = {};
      if (action !== 'check') {
        const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, revision: guide.revision, candidate_id: guide.candidate?.id, ...(action === 'approve' ? { accept_validation_window: accept, validation_timeout_minutes: 15 } : {}), ...extra }) });
        const body = await response.json(); if (!response.ok) throw new Error(body.error || 'The domain action failed.');
        result = body;
      }
      await load(); setReview(false); setAccept(false);
      setNotice(action === 'check' ? 'Checks refreshed. Review the current status below.' : action === 'prepare' ? result.reused_candidate ? 'Domain setup refreshed. The same main publication is retained; no build or DNS change was started.' : result.already_running ? 'Publication is already in progress. Follow its status here; no duplicate build was started.' : 'Publishing for the new domain started. This replaces the site at its current address. DNS is unchanged.' : action === 'rollback' ? 'Restoration requested. Typeroll checks for intervening DNS edits before restoring.' : 'Switch approved. This is not live until public verification succeeds.');
    } catch (err) { setError(err instanceof Error ? err.message : 'The domain action failed.'); }
    finally { setBusy(false); }
  }
  const needsWindow = guide?.preparation?.validation_blocker?.resolution === 'accept_validation_window';
  return <section className="stack" aria-labelledby="domain-guide-title" style={{ border: '1px solid var(--color-border)', padding: '1.25rem', borderRadius: 'var(--radius-lg, 12px)' }}>
    <h3 id="domain-guide-title">{guide?.title ?? 'Move your site to a domain'}</h3>
    <p role="status"><strong>{guide?.traffic_live ? 'Live and verified' : 'Traffic has not been confirmed live'}</strong>{guide && <> · {guide.current_phase}</>}</p>
    {guide && ['preparing', 'distributing'].includes(guide.state) && <p className="muted">{guide.elapsed_seconds != null ? `${Math.floor(guide.elapsed_seconds / 60)} min elapsed. ` : ''}The completion time depends on the build and provider checks; this page updates automatically.</p>}
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    <ol className="stack" style={{ paddingInlineStart: '1.25rem', overflowWrap: 'anywhere' }}>{guide?.checks.map(check => <li key={check.id}><strong>{check.status === 'ready' ? '✓ Ready' : check.status === 'waiting' ? '◷ Waiting' : 'Action needed'}</strong> — {check.message}</li>)}</ol>
    {!!guide?.previous_hosts?.length && <section aria-label="Previous website addresses" className="stack">
      <h4>Previous website addresses</h4>
      {guide.previous_hosts.map(host => <div key={host.host} style={{ overflowWrap: 'anywhere' }}>
        <strong>{host.host}</strong><p>{host.status === 'pending' ? 'Not verified' : host.mode === 'redirect' ? `301 → ${host.target_host}` : 'Noindex protection · redirect needs attention'}</p>
        <p className="muted">{host.message}</p>
      </div>)}
    </section>}
    <PublishingDomainOnboarding siteId={siteId} />
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '.75rem' }}>
      <button type="button" className="btn" disabled={busy} onClick={() => void action('check')}>Refresh checks</button>
      {guide?.next_action === 'publish_first' && <a className="btn btn-primary" href={`/app/sites/${encodeURIComponent(siteId)}`}>Publish your site first</a>}
      {guide?.next_action === 'prepare' && <p>This republishes the last published content with the new website and media addresses, replacing the site at its current address. Newer unpublished edits are excluded. DNS changes separately afterward; links using the new addresses may not work until then.</p>}
      {guide?.next_action === 'refresh' && <button type="button" className="btn" disabled={busy} onClick={() => void action('prepare')}>Refresh domain setup</button>}
      {guide?.next_action === 'prepare' && <button type="button" className="btn btn-primary" disabled={busy || guide.can_prepare === false} onClick={() => void action('prepare')}>Publish for the new domain</button>}
      {guide?.next_action === 'resolve_noindex' && <div className="stack" role="region" aria-label="Search engine visibility">
        <p>{guide.checks.find(check => check.id === 'candidate_noindex')?.message ?? 'This site tells search engines not to index it.'}</p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '.75rem' }}>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void action('prepare', { confirm_disable_noindex: true })}>Turn off noindex and publish for the new domain</button>
          <button type="button" className="btn" disabled={busy} onClick={() => { if (window.confirm('Keep the site hidden from search engines on the new domain? You can turn indexing on later in Site settings and publish again.')) void action('prepare', { allow_noindex_launch: true }); }}>Keep it hidden on purpose</button>
        </div>
      </div>}
      {guide?.next_action === 'approve' && <button type="button" className="btn btn-primary" disabled={busy} onClick={() => setReview(true)}>Review traffic switch</button>}
      {guide?.cutover && guide.cutover.state !== 'rolled_back' && <button type="button" className="btn" disabled={busy} onClick={() => { if (window.confirm('Restore the DNS records saved before this traffic switch? Later external edits will be reported instead of overwritten.')) void action('rollback'); }}>Restore previous traffic</button>}
    </div>
    {review && guide && <div className="stack" role="region" aria-label="Review traffic switch">
      <h4>Switch DNS to the current publication</h4><p>{guide.switch_summary.interruption}</p><p>{guide.switch_summary.rollback}</p>
      <p>Automatic validation window: 15 minutes from the traffic change. DNS propagation may outlast a rollback.</p>
      {needsWindow && <label><input type="checkbox" checked={accept} onChange={event => setAccept(event.target.checked)} /> I accept that the website may be unavailable until Cloudflare validates it.</label>}
      <button type="button" className="btn btn-primary" disabled={busy || !!needsWindow && !accept} onClick={() => void action('approve')}>Approve and switch traffic</button>
      <button type="button" className="btn" onClick={() => setReview(false)}>Cancel</button>
    </div>}
  </section>;
}
