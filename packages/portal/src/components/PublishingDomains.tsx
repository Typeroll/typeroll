import { useEffect, useRef, useState, type FormEvent } from 'react';
import { CircleCheck } from 'lucide-react';
import PublishingCard from './PublishingCard';
import OrganizationDomainStatus from './OrganizationDomainStatus';
import OrganizationDomainSetup from './OrganizationDomainSetup';
import type { OrganizationDomainStatus as DomainStatus } from '../lib/publishing/organization-domain-status';

type Preparation = { hostname?: string; validation_blocker?: { code: string; message: string; resolution?: string } | null; certificate_ready: boolean; has_existing_traffic?: boolean; requirements: Array<{ phase: string; type: string; name: string; content: string; status: string }> };
type RedirectPreparation = Preparation & { hostname: string; target_host: string; action: string; zone_id?: string; blocker?: { code: string; message: string } | null;
  rule: { zone_name: string | null; expression: string; target_url_expression: string; status: string; managed: boolean } };
type HostCheckItem = { code: string; severity: 'blocking' | 'warning'; host: string; message: string };
type DomainData = {
  domain_status?: DomainStatus;
  media_host_change_allowed?: boolean;
  sites_domain?: string | null; media_host?: string | null;
  revision: string; default_domain?: string | null; dns_mode: 'automatic' | 'external'; verified_at?: string | null;
  desired?: { website_host: string | null; media_host: string | null; media_path_prefix: string; redirect_hosts?: string[] };
  active?: { website_host: string | null; redirect_hosts?: string[] }; state?: string;
  candidate?: { id: string; sitewide_noindex?: boolean; robots_blocked?: boolean } | null;
  preparation?: Preparation | null;
  media_preparation?: Preparation | null;
  redirect_preparations?: RedirectPreparation[] | null;
  next_publication?: { error: string } | null;
  host_checks?: { blockers: HostCheckItem[]; warnings: HostCheckItem[] } | null;
};

/** The same readiness rule as the server's redirect approval check. */
function redirectBlocker(preparation: RedirectPreparation) {
  if (preparation.blocker) return preparation.blocker.message;
  if (preparation.zone_id && preparation.has_existing_traffic && preparation.action !== 'verify' && !preparation.certificate_ready) return `Waiting for the Universal SSL certificate of ${preparation.rule.zone_name ?? preparation.hostname}.`;
  return null;
}

export default function PublishingDomains({ siteId }: { siteId?: string }) {
  const FormContainer = siteId ? 'div' : 'details';
  const endpoint = siteId ? `/api/sites/${encodeURIComponent(siteId)}/publishing/domains` : '/api/orgs/publishing/domains';
  const [data, setData] = useState<DomainData | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const feedbackRef = useRef<HTMLDivElement>(null);
  const [feedbackLocation, setFeedbackLocation] = useState<'setup' | 'manual' | null>(null);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [dnsMode, setDnsMode] = useState<'automatic' | 'external'>('automatic');
  const [acceptWindow, setAcceptWindow] = useState(false);
  useEffect(() => {
    let cancelled = false;
    fetch(endpoint, { cache: 'no-store' }).then(async response => {
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not load domain settings.');
      if (!cancelled) { setData(result); setDnsMode(result.dns_mode); }
    }).catch(error => { if (!cancelled) setError(error.message); });
    return () => { cancelled = true; };
  }, [endpoint]);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!data) return;
    const form = new FormData(event.currentTarget);
    setFeedbackLocation('manual');
    setBusy(true); setError(''); setNotice('');
    try {
      const body = { revision: data.revision, ...Object.fromEntries(form.entries()) };
      const response = await fetch(endpoint, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not save domain settings.');
      setData(result); setDnsMode(result.dns_mode);
      setNotice(siteId ? 'Future addresses saved. Prepare and verify a deployment before switching website traffic.' : 'Organization domains saved. Check the connection status and next steps below.');
    } catch (error) { setError(error instanceof Error ? error.message : 'Could not save domain settings.'); }
    finally { setBusy(false); }
  }
  async function refresh() {
    const response = await fetch(endpoint, { cache: 'no-store' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not check publishing status.');
    if (!siteId) {
      if (data && result.revision !== data.revision) throw new Error('Domain settings changed in another session. Reload before saving; your entered values are still shown.');
      setData(current => current ? { ...current, domain_status: result.domain_status } : result);
    } else setData(result);
    return result;
  }
  useEffect(() => {
    if (siteId) return;
    const changed = () => { void refresh().catch(error => setError(error.message)); };
    window.addEventListener('typeroll:publishing-connection-changed', changed);
    return () => window.removeEventListener('typeroll:publishing-connection-changed', changed);
  }, [endpoint, siteId, data?.revision]);
  async function checkOrganizationDomain() {
    setChecking(true); setError('');
    try { return (await refresh()).domain_status as DomainStatus | undefined; }
    finally { setChecking(false); }
  }
  async function setupOrganization(body: Record<string, string>) {
    setFeedbackLocation('setup');
    setBusy(true); setError(''); setNotice('');
    try {
      const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not configure domains.');
      setData(result); setDnsMode(result.dns_mode);
      if (result.setup_error) { setError(result.setup_error); setNotice('The addresses are saved. Cloudflare setup still needs attention.'); }
      else setNotice(result.domain_status?.state === 'active' ? 'The media domain is active. Each site and version gets its own address when you publish.' : 'Cloudflare activation is checked automatically. Each site and version gets its own address when you publish.');
    } catch (error) { setError(error instanceof Error ? error.message : 'Could not configure domains.'); }
    finally { setBusy(false); }
  }
  useEffect(() => {
    if (siteId || data?.domain_status?.state !== 'pending') return;
    const interval = setInterval(() => { void refresh().catch(error => setError(error.message)); }, 5000);
    return () => clearInterval(interval);
  }, [endpoint, siteId, data?.revision, data?.domain_status?.state]);
  async function prepare() {
    if (!data) return;
    setBusy(true); setError('');
    try {
      const response = await fetch(endpoint.replace(/domains$/, 'prepare'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: data.revision }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not prepare the domain change.');
      setNotice('Preparing the last published content with the new addresses. Saved changes stay unpublished. Verification updates automatically.');
      await refresh();
    } catch (error) { setError(error instanceof Error ? error.message : 'Could not prepare the domain change.'); }
    finally { setBusy(false); }
  }
  useEffect(() => {
    if (!siteId || !data || data.state === 'live' || data.state === 'unconfigured') return;
    const interval = setInterval(() => { void refresh().catch(error => setError(error.message)); }, 5000);
    return () => clearInterval(interval);
  }, [endpoint, siteId, data?.state]);
  async function checkSiteDomain() {
    setChecking(true); setError(''); setNotice('');
    try {
      const current = await refresh();
      const blocker = current.preparation?.validation_blocker ?? current.media_preparation?.validation_blocker;
      setNotice(blocker ? 'Checked: Cloudflare can validate the website host only after its record changes. See the explanation below.'
        : current.preparation?.certificate_ready && (!current.media_preparation || current.media_preparation.certificate_ready)
        ? 'Checked: Cloudflare has confirmed the website and media certificates.'
        : 'Checked: domain validation is still pending. Keep existing traffic in place.');
    } catch (error) { setError(error instanceof Error ? error.message : 'Could not check domain verification.'); }
    finally { setChecking(false); }
  }
  async function switchTraffic() {
    if (!data?.candidate) return;
    setBusy(true); setError('');
    try {
      const response = await fetch(endpoint.replace(/domains$/, 'cutover'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: data.revision, candidate_id: data.candidate.id, ...(windowRequired ? { accept_validation_window: acceptWindow } : {}) }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not switch website traffic.');
      setData(result); setNotice('Traffic switch approved. Typeroll will verify the deployment at your website address before showing its live link.');
    } catch (error) { setError(error instanceof Error ? error.message : 'Could not switch website traffic.'); }
    finally { setBusy(false); }
  }
  useEffect(() => {
    if (siteId || busy || (!notice && !error)) return;
    feedbackRef.current?.focus({ preventScroll: true });
    feedbackRef.current?.scrollIntoView({ block: 'nearest' });
  }, [siteId, busy, notice, error]);
  const organizationFeedback = <div ref={feedbackRef} tabIndex={-1}>
    {notice && <div role="status" className={`publishing-domain-confirmation${error ? ' publishing-domain-confirmation--warning' : ''}`}>
      <div className="publishing-domain-confirmation__title"><CircleCheck size={24} aria-hidden="true" /><strong>Domain settings saved</strong></div>
      <p>Media: <strong>{data?.media_host || 'Not set'}</strong><br />Site address base: <strong>{data?.sites_domain || 'Not set'}</strong></p>
      <p>{notice}</p>
    </div>}
    {error && <p role="alert">{error}</p>}
  </div>;
  const validationBlocker = data?.preparation?.validation_blocker ?? data?.media_preparation?.validation_blocker;
  const windowRequired = data?.preparation?.validation_blocker?.resolution === 'accept_validation_window' && !data?.media_preparation?.validation_blocker;
  const redirectPreparations = data?.redirect_preparations ?? [];
  const redirectWaiting = redirectPreparations.some(item => redirectBlocker(item));
  const hostBlockers = data?.host_checks?.blockers ?? [];
  const hostWarnings = data?.host_checks?.warnings ?? [];
  const alertStyle = { borderLeft: '4px solid var(--color-danger)', background: 'color-mix(in srgb, var(--color-danger) 6%, var(--color-surface))', padding: '1rem', borderRadius: 6 };
  const content = <>
    <p>{siteId ? 'Choose the website host and the host used for images and other media. Saving these addresses prepares a future change; your current website stays live at its existing address.' : 'Choose addresses for your sites and media. Each site can also use its own domain.'}</p>
    {error && (siteId || !feedbackLocation) && <p role="alert">{error}</p>}
    {siteId && notice && <p role="status">{notice}</p>}
    {!data && !error && <p role="status">Loading domain settings…</p>}
    {siteId && hostBlockers.length > 0 && <div role="alert" style={alertStyle}>
      <strong>Resolve before preparing the domain change</strong>
      <ul>{hostBlockers.map(item => <li key={item.code + item.host}>{item.message}</li>)}</ul>
    </div>}
    {siteId && hostWarnings.length > 0 && <div className="muted"><strong>Check before preparing</strong><ul>{hostWarnings.map(item => <li key={item.code + item.host}>{item.message}</li>)}</ul></div>}
    {siteId && data?.next_publication && <p role="status">{data.next_publication.error}</p>}
    {siteId && data?.active && data.state !== 'live' && <button type="button" className="btn" disabled={busy || hostBlockers.length > 0} onClick={() => void prepare()}>Prepare domain change from published content</button>}
    {data?.preparation && <div className="stack">
      <h3>Domain verification</h3>
      {validationBlocker && <div role="alert" style={alertStyle}><strong>{windowRequired ? 'The switch has a short validation window' : 'Domain transition needs a DNS change outside Typeroll'}</strong><p>{validationBlocker.message}</p></div>}
      {redirectPreparations.map(item => <p key={item.hostname}>{redirectBlocker(item)
        ? <>Redirect from <strong>{item.hostname}</strong>: {redirectBlocker(item)}</>
        : <>Redirect from <strong>{item.hostname}</strong> to {item.target_host} is {item.action === 'verify' ? 'active' : 'ready to switch with the website'}.</>}</p>)}
      {!validationBlocker && data.media_preparation && <p>{data.media_preparation.certificate_ready ? 'Media domain certificate confirmed.' : 'Media domain validation is still pending. Keep existing media DNS in place.'}</p>}
      {!validationBlocker && <p>{data.preparation.certificate_ready ? 'Cloudflare has confirmed the certificate.' : 'Waiting for Cloudflare to confirm the certificate. Keep existing website DNS in place until validation is complete.'}</p>}
      <details>
        <summary>DNS records and instructions</summary>
        {[...data.preparation.requirements, ...(data.media_preparation?.requirements ?? []), ...redirectPreparations.flatMap(item => item.requirements)].map(record => <div key={record.phase + record.name} style={{ border: '1px solid var(--color-border)', borderRadius: 6, padding: '0.75rem', marginTop: '0.75rem' }}>
          <strong>{record.phase === 'traffic' ? 'Traffic — after approval' : 'Certificate validation'}</strong>
          <dl style={{ display: 'grid', gridTemplateColumns: '4rem minmax(0, 1fr)', gap: '0.5rem', margin: '0.75rem 0 0' }}>
            <dt>Type</dt><dd style={{ margin: 0 }}><code>{record.type}</code></dd>
            <dt>Name</dt><dd style={{ margin: 0, overflowWrap: 'anywhere' }}><code>{record.name}</code></dd>
            <dt>Value</dt><dd style={{ margin: 0, overflowWrap: 'anywhere' }}><code>{record.content}</code></dd>
          </dl>
        </div>)}
        {redirectPreparations.map(item => <div key={`rule-${item.hostname}`} style={{ border: '1px solid var(--color-border)', borderRadius: 6, padding: '0.75rem', marginTop: '0.75rem' }}>
          <strong>Redirect rule — {item.rule.status === 'configured' ? 'present' : item.rule.managed ? 'created by Typeroll' : 'create in Cloudflare'}</strong>
          <dl style={{ display: 'grid', gridTemplateColumns: '6rem minmax(0, 1fr)', gap: '0.5rem', margin: '0.75rem 0 0' }}>
            <dt>Where</dt><dd style={{ margin: 0, overflowWrap: 'anywhere' }}>{item.rule.zone_name ?? item.hostname} → Rules → Redirect Rules</dd>
            <dt>Expression</dt><dd style={{ margin: 0, overflowWrap: 'anywhere' }}><code>{item.rule.expression}</code></dd>
            <dt>Dynamic URL</dt><dd style={{ margin: 0, overflowWrap: 'anywhere' }}><code>{item.rule.target_url_expression}</code></dd>
            <dt>Status</dt><dd style={{ margin: 0 }}>301, preserve query string</dd>
          </dl>
        </div>)}
        {!validationBlocker && <p className="muted">In Cloudflare, select your domain → DNS → Records. Add validation records first. Apply the website CNAME only after the prepared deployment is ready. Version addresses require a proxied Cloudflare CNAME. A redirect host needs its proxied record and redirect rule; it does not serve pages.</p>}
      </details>
      <button type="button" className="btn" disabled={busy || checking} onClick={() => void checkSiteDomain()}>{checking ? 'Checking…' : 'Refresh verification'}</button>
      {data.candidate && data.state === 'ready_to_switch' && <>
        <p>The prepared build uses the future website and media addresses. Switching traffic makes this build public.</p>
        {data.candidate?.sitewide_noindex === true && <p role="alert">This frozen candidate has noindex enabled. Switching traffic will not make it indexable. If search indexing is intended, do not switch this candidate: change the site indexing setting and prepare a new saved-content candidate. A domain-only preparation reuses the old published settings.</p>}
        {data.candidate && data.candidate.sitewide_noindex === undefined && <p>Indexing status is unavailable for this older candidate. Verify its actual robots output before switching traffic; current CMS settings do not change a frozen candidate.</p>}
        {windowRequired && <label className="field" style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start' }}>
          <input type="checkbox" checked={acceptWindow} onChange={event => setAcceptWindow(event.target.checked)} style={{ width: 'auto', marginTop: '0.25rem' }} />
          <span>I am switching at a quiet time and accept that {data.preparation.hostname ?? 'the website'} does not answer until Cloudflare validates it.</span>
        </label>}
        <button type="button" className="btn" disabled={busy || redirectWaiting || (windowRequired ? !acceptWindow : (!data.preparation.certificate_ready && data.preparation.has_existing_traffic !== false)) || Boolean(data.media_preparation && !data.media_preparation.certificate_ready && data.media_preparation.has_existing_traffic !== false)} onClick={() => void switchTraffic()}>Switch website traffic</button>
      </>}
    </div>}
    {!siteId && data && <OrganizationDomainSetup data={data} busy={busy || checking} onSetup={setupOrganization} feedback={feedbackLocation === 'setup' ? organizationFeedback : undefined} />}
    {data && <FormContainer>
    {!siteId && <summary>Manual settings or external DNS</summary>}
    <form className="stack" onSubmit={save} key={data.revision}>
      {siteId ? <>
        <label className="field">Website host<input name="website_host" defaultValue={data.desired?.website_host ?? ''} placeholder="www.example.com" autoCapitalize="none" spellCheck={false} /></label>
        <label className="field">Redirect hosts<input name="redirect_hosts" defaultValue={(data.desired?.redirect_hosts ?? []).join(', ')} placeholder="www.example.com when the website host is example.com" autoCapitalize="none" spellCheck={false} /></label>
        <p className="muted">Each redirect host answers with a permanent redirect to the website host and keeps the path and query. It needs an active Cloudflare zone; a website host on the domain itself, such as example.com, must be an active zone in the hosting account.</p>
        <label className="field">Media host<input name="media_host" defaultValue={data.desired?.media_host ?? ''} placeholder="Leave empty to serve images with the website" autoCapitalize="none" spellCheck={false} /></label>
        <label className="field">Media path prefix<input name="media_path_prefix" defaultValue={data.desired?.media_path_prefix ?? ''} placeholder="/media when using the website host" autoCapitalize="none" spellCheck={false} /></label>
        <p className="muted">Leave the media path prefix empty for a separate media host. Use /media when the website and media share a host. Existing media addresses remain available after the change.</p>
        {data.active?.website_host && <p>Current website host: {data.active.website_host}</p>}
      </> : <>
        <label className="field">Site address base<input name="sites_domain" defaultValue={(data.sites_domain === undefined ? data.default_domain : data.sites_domain) ?? ''} placeholder="sites.example.com" autoCapitalize="none" spellCheck={false} /></label>
        <p className="muted">Used for addresses such as site-123.sites.example.com, including separate versions. Each site can later use its own domain.</p>
        <label className="field">Shared media host<input name="media_host" defaultValue={(data.media_host === undefined ? data.default_domain : data.media_host) ?? ''} placeholder="media.example.com" autoCapitalize="none" spellCheck={false} /></label>
        <p className="muted">Public images and other media use this host, with a separate path for each site.</p>
      </>}
      <label className="field">DNS management<select name="dns_mode" value={dnsMode} onChange={event => setDnsMode(event.target.value as 'automatic' | 'external')} style={{ width: '100%', minWidth: 0 }}>
        <option value="automatic">Typeroll (automatic)</option>
        <option value="external">Me or my AI agent</option>
      </select></label>
      <p className="muted">{siteId ? 'Saving sets future addresses. Prepare and verify a deployment before switching website traffic.' : dnsMode === 'automatic' ? 'Typeroll sets up the media hostname in the connected Cloudflare account after you save. The domain must already be active in that account. DNS at another provider still needs manual setup there.' : 'You or your AI agent set up the domain and DNS records, then Typeroll checks the result. This works with Cloudflare DNS or another DNS provider.'}</p>
      <p className="muted">External DNS for R2 media requires Cloudflare Business/Enterprise partial (CNAME) setup. Your nameservers and other DNS records stay where they are.</p>
      <div><button className="btn" type="submit" disabled={busy || checking}>{busy ? 'Saving…' : 'Save domain settings'}</button></div>
    {!siteId && feedbackLocation === 'manual' && organizationFeedback}
    </form></FormContainer>}
    {!siteId && data?.sites_domain && <p className="muted">Site address base: <strong>{data.sites_domain}</strong></p>}
    {!siteId && data && <OrganizationDomainStatus key={data.revision} status={data.domain_status} checking={checking || busy} onRefresh={checkOrganizationDomain} />}
  </>;
  if (siteId) return <section className="card stack" style={{ maxWidth: 720, minWidth: 0, overflowWrap: 'anywhere', marginBottom: '1rem' }}><h2 style={{ fontSize: '1.125rem' }}>Website and media addresses</h2>{content}</section>;
  const waiting = busy || checking || (!data && !error) || data?.domain_status?.state === 'pending';
  const ready = !error && data?.domain_status?.state === 'active';
  return <PublishingCard id="domains" title="Domains" state={waiting ? 'waiting' : ready ? 'ready' : 'error'}
    status={busy ? 'Saving domains…' : checking ? 'Checking domains…' : !data && !error ? 'Loading…' : error ? 'Domains need attention' : data?.domain_status?.state === 'pending' ? 'Waiting for activation' : ready ? 'Media domain connected' : 'Setup required'}>{content}</PublishingCard>;
}
