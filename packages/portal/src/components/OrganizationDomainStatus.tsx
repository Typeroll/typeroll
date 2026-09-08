import { useEffect, useRef, useState } from 'react';
import { CircleCheck, CircleX, Clock3 } from 'lucide-react';
import './OrganizationDomainSetup.css';
import type { OrganizationDomainStatus as Status } from '../lib/publishing/organization-domain-status';

const labels: Record<Status['state'], string> = {
  not_configured: 'No shared media host saved', cloudflare_required: 'Connect Cloudflare', storage_required: 'Complete R2 setup',
  setup_required: 'Domain setup needed', pending: 'Waiting for domain activation', active: 'Media domain active in Cloudflare', check_failed: 'Status could not be checked',
};

export default function OrganizationDomainStatus({ status, checking, onRefresh }: { status?: Status; checking: boolean; onRefresh: () => Promise<Status | undefined> }) {
  const [feedback, setFeedback] = useState<{ status?: Status; error?: string } | null>(null);
  const feedbackRef = useRef<HTMLDivElement>(null);
  async function check() {
    if (checking) return;
    setFeedback(null);
    try {
      const result = await onRefresh();
      if (!result) throw new Error('No domain status was returned. Try checking again.');
      setFeedback({ status: result });
    } catch (error) {
      setFeedback({ error: error instanceof TypeError || error instanceof SyntaxError ? 'Could not reach Typeroll. Check your connection and try again.' : error instanceof Error ? error.message : 'Could not check domain status. Try again.' });
    }
  }
  useEffect(() => {
    if (!feedback) return;
    feedbackRef.current?.focus({ preventScroll: true });
    feedbackRef.current?.scrollIntoView({ block: 'nearest' });
  }, [feedback]);
  const state = feedback?.status?.state;
  const tone = state === 'active' ? 'ready' : state === 'pending' ? 'waiting' : 'error';
  const Icon = tone === 'ready' ? CircleCheck : tone === 'waiting' ? Clock3 : CircleX;
  const title = feedback?.error || state === 'check_failed' ? 'Could not check domain status' : state === 'active' ? 'Domain verified' : state === 'pending' ? 'Still waiting for domain activation' : state ? labels[state] : '';
  return <div className="stack" style={{ minWidth: 0, overflowWrap: 'anywhere', borderTop: '1px solid var(--border)', paddingTop: '1rem' }}>
    <h3 style={{ fontSize: '1rem' }}>Shared media domain status</h3>
    {status ? <>
      <p><strong>{labels[status.state]}</strong></p>
      {status.hostname && <p>Media host: <strong>{status.hostname}</strong></p>}
      <p>{status.message}</p>
      <details><summary>Domain connection details</summary>
      {status.account_name && <p className="muted">Cloudflare account: <strong>{status.account_name}</strong></p>}
      {status.public_bucket && <p className="muted">Public media bucket: <code>{status.public_bucket}</code></p>}
      {(status.ownership || status.certificate) && <p className="muted">Domain ownership: {status.ownership ?? 'not checked'} · HTTPS certificate: {status.certificate ?? 'not checked'}</p>}
      {status.zone && <p className="muted">{status.zone.name}: {status.zone.type === 'full' ? 'Cloudflare DNS' : status.zone.type === 'partial' ? 'External DNS with Cloudflare partial setup' : 'DNS setup type not available'} · {status.zone.status}</p>}
      <p className="muted">Last checked: <time dateTime={status.checked_at}>{new Date(status.checked_at).toLocaleString()}</time></p></details>
    </> : <p className="muted">Check the saved domain’s current connection and certificate status.</p>}
    <div><button type="button" className="btn" disabled={checking} onClick={() => void check()}>{checking ? 'Checking domain…' : 'Check domain status'}</button></div>
    {feedback && <div ref={feedbackRef} tabIndex={-1} role={tone === 'error' ? 'alert' : 'status'} data-state={tone}
      className={`publishing-domain-confirmation publishing-domain-check${tone === 'waiting' ? ' publishing-domain-confirmation--warning' : tone === 'error' ? ' publishing-domain-confirmation--error' : ''}`}>
      <div className="publishing-domain-confirmation__title"><Icon size={24} aria-hidden="true" /><strong>{title}</strong></div>
      {feedback.status?.hostname && <p><strong>{feedback.status.hostname}</strong></p>}
      <p>{feedback.error || feedback.status?.message}</p>
      {feedback.status && <p>Checked: <time dateTime={feedback.status.checked_at}>{new Date(feedback.status.checked_at).toLocaleString()}</time></p>}
    </div>}
    <p className="muted">Checking status does not change DNS or publish a website.</p>
    {!!status?.steps.length && <details>
      <summary>Setup instructions</summary>
      <ol className="stack" style={{ paddingLeft: '1.25rem', marginTop: '1rem' }}>
        {status.steps.map(step => <li key={step.title}><strong>{step.title}</strong><p>{step.description}</p>{step.url && <a href={step.url} target="_blank" rel="noreferrer">{step.url.startsWith('https://dash.cloudflare.com/') ? 'Open bucket settings in Cloudflare' : 'Open Cloudflare instructions'}</a>}</li>)}
      </ol>
    </details>}
  </div>;
}
