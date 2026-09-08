import { useEffect, useState, type FormEvent } from 'react';
import type { PublishingZone } from '../lib/publishing/organization-domain-setup';

type Settings = { media_host_change_allowed?: boolean; revision: string; media_host?: string | null; sites_domain?: string | null };
export default function OrganizationDomainSetup({ data, busy, onSetup }: { data: Settings; busy: boolean; onSetup: (body: Record<string, string>) => Promise<void> }) {
  const [zones, setZones] = useState<PublishingZone[]>([]);
  const [zoneId, setZoneId] = useState('');
  const [account, setAccount] = useState('');
  const [connectionRequired, setConnectionRequired] = useState(false);
  const [approvalRequired, setApprovalRequired] = useState(false);
  const [authorizing, setAuthorizing] = useState(false);
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [media, setMedia] = useState('media');
  const [sites, setSites] = useState('sites');
  const zone = zones.find(value => value.id === zoneId);
  function selectZone(id: string, available = zones) {
    setZoneId(id);
    const selected = available.find(value => value.id === id);
    const label = (host?: string | null) => selected && host?.endsWith(`.${selected.name}`) ? host.slice(0, -selected.name.length - 1) : null;
    setMedia(label(data.media_host) ?? 'media');
    setSites(label(data.sites_domain) ?? 'sites');
  }
  async function load(manual = false) {
    setLoading(true); setError(''); setNotice('');
    try {
      const response = await fetch('/api/orgs/publishing/zones', { cache: 'no-store' });
      const result = await response.json();
      if (result.code === 'cloudflare_required') { setZones([]); setZoneId(''); setConnectionRequired(true); setApprovalRequired(false); return; }
      if (result.code === 'domain_access_required') setApprovalRequired(true);
      if (!response.ok) throw new Error(result.error || 'Could not load Cloudflare domains. Try refreshing the list.');
      setConnectionRequired(false); setZones(result.zones); setAccount(result.account_name);
      setApprovalRequired(result.domain_access === 'approval_required');
      if (manual) setNotice('Domain list updated.');
      // Refreshing provider status must not erase edits or silently select a different domain.
      if (!zoneId) {
        const preferred = result.zones.find((candidate: PublishingZone) => data.media_host?.endsWith(`.${candidate.name}`))
          ?? result.zones.find((candidate: PublishingZone) => candidate.status === 'active' && candidate.type === 'full');
        if (preferred) selectZone(preferred.id, result.zones);
      }
    } catch (error) { setError(error instanceof Error ? error.message : 'Could not load Cloudflare domains.'); }
    finally { setLoading(false); }
  }
  useEffect(() => {
    void load();
    const changed = () => { setZones([]); setZoneId(''); setApprovalRequired(false); void load(); };
    window.addEventListener('typeroll:publishing-connection-changed', changed);
    return () => window.removeEventListener('typeroll:publishing-connection-changed', changed);
  }, []);
  async function allowDomainAccess() {
    setAuthorizing(true); setError('');
    try {
      const response = await fetch('/api/orgs/publishing/cloudflare', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'start' }) });
      const result = await response.json();
      if (!response.ok || !result.authorization_url) throw new Error(result.error || 'Could not open Cloudflare approval. Try again.');
      window.location.assign(result.authorization_url);
    } catch (error) { setError(error instanceof Error ? error.message : 'Could not open Cloudflare approval.'); setAuthorizing(false); }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    await onSetup({ revision: data.revision, zone_id: zoneId, media_subdomain: media, sites_subdomain: sites });
  }
  const differentMedia = Boolean(data.media_host && zone && `${media.trim().toLowerCase()}.${zone.name}` !== data.media_host);
  const mediaChangeBlocked = differentMedia && data.media_host_change_allowed !== true;
  return <div className="stack">
    <p>Select a domain, then name the subdomains for media and sites.</p>
    {error && <p role="alert">{error}</p>}
    {loading && <p role="status">Loading Cloudflare domains…</p>}
    {!loading && notice && <p role="status">{notice}</p>}
    {approvalRequired && <div className="stack">
      <p>Allow Typeroll to read domains and manage their DNS in {account || 'your connected account'}. Cloudflare will ask you to approve this access. Your account connection and R2 settings are kept.</p>
      <div><button type="button" className="btn" disabled={busy || authorizing} onClick={() => void allowDomainAccess()}>{authorizing ? 'Opening Cloudflare…' : 'Allow domain access'}</button></div>
    </div>}
    {connectionRequired && <p>Connect Cloudflare to choose domains.</p>}
    {!loading && !error && !connectionRequired && !approvalRequired && !zones.length && <p>No domains were returned for {account || 'the connected account'}. If you just added a domain in Cloudflare, refresh the list once it is available.</p>}
    <form className="stack" onSubmit={submit}>
      <label className="field">Cloudflare domain<select value={zoneId} onChange={event => selectZone(event.target.value)} disabled={busy || loading} style={{ minWidth: 0, width: '100%' }}>
        <option value="">Choose a domain</option>
        {zones.map(value => <option key={value.id} value={value.id}>{value.name}{value.status !== 'active' ? ' — activation pending' : value.type !== 'full' ? ' — external DNS' : ''}</option>)}
      </select></label>
      {zone && <>
        <label className="field">Media subdomain<input value={media} onChange={event => setMedia(event.target.value)} required maxLength={63} pattern={"[a-zA-Z0-9](?:[a-zA-Z0-9\\-]{0,61}[a-zA-Z0-9])?"} autoCapitalize="none" spellCheck={false} disabled={busy} /></label>
        <p className="muted">Images and files: <strong>{media.trim().toLowerCase() || 'media'}.{zone.name}</strong></p>
        <label className="field">Sites subdomain<input value={sites} onChange={event => setSites(event.target.value)} required maxLength={63} pattern={"[a-zA-Z0-9](?:[a-zA-Z0-9\\-]{0,61}[a-zA-Z0-9])?"} autoCapitalize="none" spellCheck={false} disabled={busy} /></label>
        <p className="muted">Site and version addresses: <strong>site-123.{sites.trim().toLowerCase() || 'sites'}.{zone.name}</strong>. Each site can later use its own domain.</p>
        {zone.status !== 'active' && <p>Cloudflare is still activating this domain. Complete its setup in Cloudflare → Domains, then refresh the list.</p>}
        {zone.type !== 'full' && <p>This domain uses external DNS. Open manual settings below for setup instructions.</p>}
        {differentMedia && !mediaChangeBlocked && <p>The saved media hostname has not been used. You can replace it with this address.</p>}
        {mediaChangeBlocked && <p>Keep your existing media host, {data.media_host}, so published image links continue to work. Changing it requires a domain migration.</p>}
      </>}
      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
        <button type="submit" className="btn" disabled={busy || loading || approvalRequired || !zone || zone.status !== 'active' || zone.type !== 'full' || mediaChangeBlocked}>{busy ? 'Configuring domains…' : 'Configure domains'}</button>
        <button type="button" className="btn" disabled={busy || loading} onClick={() => void load(true)}>Refresh domain list</button>
      </div>
    </form>
  </div>;
}
