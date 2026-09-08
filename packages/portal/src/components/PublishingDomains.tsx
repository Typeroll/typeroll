import { useEffect, useState, type FormEvent } from 'react';
import PublishingCard from './PublishingCard';
import OrganizationDomainStatus from './OrganizationDomainStatus';
import OrganizationDomainSetup from './OrganizationDomainSetup';
import type { OrganizationDomainStatus as DomainStatus } from '../lib/publishing/organization-domain-status';

type DomainData = {
  domain_status?: DomainStatus;
  sites_domain?: string | null; media_host?: string | null;
  revision: string; default_domain?: string | null; dns_mode: 'automatic' | 'external'; verified_at?: string | null;
  desired?: { website_host: string | null; media_host: string | null; media_path_prefix: string };
  active?: { website_host: string | null }; state?: string;
  candidate?: { id: string } | null;
  preparation?: { certificate_ready: boolean; has_existing_traffic?: boolean; requirements: Array<{ phase: string; type: string; name: string; content: string; status: string }> } | null;
};

export default function PublishingDomains({ siteId }: { siteId?: string }) {
  const FormContainer = siteId ? 'div' : 'details';
  const endpoint = siteId ? `/api/sites/${encodeURIComponent(siteId)}/publishing/domains` : '/api/orgs/publishing/domains';
  const [data, setData] = useState<DomainData | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [dnsMode, setDnsMode] = useState<'automatic' | 'external'>('automatic');
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
  }
  useEffect(() => {
    if (siteId) return;
    const changed = () => { void refresh().catch(error => setError(error.message)); };
    window.addEventListener('typeroll:publishing-connection-changed', changed);
    return () => window.removeEventListener('typeroll:publishing-connection-changed', changed);
  }, [endpoint, siteId, data?.revision]);
  async function checkOrganizationDomain() {
    setChecking(true); setError('');
    try { await refresh(); }
    catch (error) { setError(error instanceof Error ? error.message : 'Could not check domain status.'); }
    finally { setChecking(false); }
  }
  async function setupOrganization(body: Record<string, string>) {
    setBusy(true); setError(''); setNotice('');
    try {
      const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not configure domains.');
      setData(result); setDnsMode(result.dns_mode);
      if (result.setup_error) setError(result.setup_error);
      else setNotice('Domains configured. Cloudflare activation is checked automatically. Each site and version gets its own address when you publish.');
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
  async function switchTraffic() {
    if (!data?.candidate) return;
    setBusy(true); setError('');
    try {
      const response = await fetch(endpoint.replace(/domains$/, 'cutover'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: data.revision, candidate_id: data.candidate.id }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not switch website traffic.');
      setData(result); setNotice('Traffic switch approved. Typeroll will verify the deployment at your website address before showing its live link.');
    } catch (error) { setError(error instanceof Error ? error.message : 'Could not switch website traffic.'); }
    finally { setBusy(false); }
  }
  const content = <>
    <p>{siteId ? 'Choose the website host and the host used for images and other media. Saving these addresses prepares a future change; your current website stays live at its existing address.' : 'Choose addresses for your sites and media. Each site can also use its own domain.'}</p>
    {error && <p role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {!data && !error && <p role="status">Loading domain settings…</p>}
    {siteId && data?.active && data.state !== 'live' && <button type="button" className="btn" disabled={busy} onClick={() => void prepare()}>Prepare domain change from published content</button>}
    {data?.preparation && <div className="stack">
      <h3>Domain verification</h3>
      <p>{data.preparation.certificate_ready ? 'Cloudflare has confirmed the certificate.' : 'Waiting for Cloudflare to confirm the certificate. Keep existing website DNS in place until validation is complete.'}</p>
      <div style={{ overflowX: 'auto' }}><table><thead><tr><th>Purpose</th><th>Type</th><th>Name</th><th>Value</th></tr></thead><tbody>
        {data.preparation.requirements.map(record => <tr key={record.phase + record.name}><td>{record.phase === 'traffic' ? 'Website traffic — after approval' : 'Certificate validation'}</td><td>{record.type}</td><td><code>{record.name}</code></td><td><code>{record.content}</code></td></tr>)}
      </tbody></table></div>
      <p className="muted">In Cloudflare, select your domain → DNS → Records. Add validation records first. Apply the website CNAME only after the prepared deployment is ready. Version addresses require a proxied Cloudflare CNAME.</p>
      <button type="button" className="btn" disabled={busy} onClick={() => void refresh().catch(error => setError(error.message))}>Refresh verification</button>
      {data.candidate && data.state === 'ready_to_switch' && <>
        <p>The prepared build uses the future website and media addresses. Switching traffic makes this build public.</p>
        <button type="button" className="btn" disabled={busy || (!data.preparation.certificate_ready && data.preparation.has_existing_traffic !== false)} onClick={() => void switchTraffic()}>Switch website traffic</button>
      </>}
    </div>}
    {!siteId && data && <OrganizationDomainSetup data={data} busy={busy || checking} onSetup={setupOrganization} />}
    {data && <FormContainer>
    {!siteId && <summary>Manual settings or external DNS</summary>}
    <form className="stack" onSubmit={save} key={data.revision}>
      {siteId ? <>
        <label className="field">Website host<input name="website_host" defaultValue={data.desired?.website_host ?? ''} placeholder="www.example.com" autoCapitalize="none" spellCheck={false} /></label>
        <label className="field">Media host<input name="media_host" defaultValue={data.desired?.media_host ?? ''} placeholder="media.example.com" autoCapitalize="none" spellCheck={false} /></label>
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
    </form></FormContainer>}
    {!siteId && data?.sites_domain && <p className="muted">Site address base: <strong>{data.sites_domain}</strong></p>}
    {!siteId && data && <OrganizationDomainStatus status={data.domain_status} checking={checking || busy} onRefresh={() => void checkOrganizationDomain()} />}
  </>;
  if (siteId) return <section className="card stack" style={{ maxWidth: 720, minWidth: 0, overflowWrap: 'anywhere', marginBottom: '1rem' }}><h2 style={{ fontSize: '1.125rem' }}>Website and media addresses</h2>{content}</section>;
  const waiting = busy || checking || (!data && !error) || data?.domain_status?.state === 'pending';
  const ready = !error && data?.domain_status?.state === 'active';
  return <PublishingCard id="domains" title="Domains" state={waiting ? 'waiting' : ready ? 'ready' : 'error'}
    status={busy ? 'Saving domains…' : checking ? 'Checking domains…' : !data && !error ? 'Loading…' : error ? 'Domains need attention' : data?.domain_status?.state === 'pending' ? 'Waiting for activation' : ready ? 'Media domain connected' : 'Setup required'}>{content}</PublishingCard>;
}
