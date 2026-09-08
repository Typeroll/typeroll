import { useEffect, useState, type FormEvent } from 'react';

type DomainData = {
  revision: string; default_domain?: string | null; dns_mode: 'automatic' | 'external'; verified_at?: string | null;
  desired?: { website_host: string | null; media_host: string | null; media_path_prefix: string };
  active?: { website_host: string | null }; state?: string;
  candidate?: { id: string } | null;
  preparation?: { certificate_ready: boolean; has_existing_traffic?: boolean; requirements: Array<{ phase: string; type: string; name: string; content: string; status: string }> } | null;
};

export default function PublishingDomains({ siteId }: { siteId?: string }) {
  const endpoint = siteId ? `/api/sites/${encodeURIComponent(siteId)}/publishing/domains` : '/api/orgs/publishing/domains';
  const [data, setData] = useState<DomainData | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let cancelled = false;
    fetch(endpoint, { cache: 'no-store' }).then(async response => {
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not load domain settings.');
      if (!cancelled) setData(result);
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
      setData(result);
      setNotice(siteId ? 'Future addresses saved. Prepare and verify a deployment before switching website traffic.' : 'Default domain saved. Domain verification is required before public use.');
    } catch (error) { setError(error instanceof Error ? error.message : 'Could not save domain settings.'); }
    finally { setBusy(false); }
  }
  async function refresh() {
    const response = await fetch(endpoint, { cache: 'no-store' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not check publishing status.');
    setData(result);
  }
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
  return <section className="card stack" style={{ maxWidth: 720, marginBottom: '1rem' }}>
    <h2 style={{ fontSize: '1.125rem' }}>{siteId ? 'Website and media addresses' : 'Default domain'}</h2>
    <p>{siteId ? 'Choose the website host and the host used for images and other media. Saving these addresses prepares a future change; your current website stays live at its existing address.' : 'Use this hostname for shared media, with site and version addresses under it. Each site can later use its own website and media hosts. You can edit, save and share a temporary preview before connecting a domain.'}</p>
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
    {data && <form className="stack" onSubmit={save} key={data.revision}>
      {siteId ? <>
        <label className="field">Website host<input name="website_host" defaultValue={data.desired?.website_host ?? ''} placeholder="www.example.com" autoCapitalize="none" spellCheck={false} /></label>
        <label className="field">Media host<input name="media_host" defaultValue={data.desired?.media_host ?? ''} placeholder="media.example.com" autoCapitalize="none" spellCheck={false} /></label>
        <label className="field">Media path prefix<input name="media_path_prefix" defaultValue={data.desired?.media_path_prefix ?? ''} placeholder="/media when using the website host" autoCapitalize="none" spellCheck={false} /></label>
        <p className="muted">Leave the media path prefix empty for a separate media host. Use /media when the website and media share a host. Existing media addresses remain available after the change.</p>
        {data.active?.website_host && <p>Current website host: {data.active.website_host}</p>}
      </> : <label className="field">Organization default domain<input name="default_domain" defaultValue={data.default_domain ?? ''} placeholder="demos.example.com" autoCapitalize="none" spellCheck={false} /></label>}
      <label className="field">DNS management<select name="dns_mode" defaultValue={data.dns_mode} style={{ width: '100%', minWidth: 0 }}>
        <option value="automatic">Typeroll manages DNS in Cloudflare</option>
        <option value="external">I or my AI agent manage DNS</option>
      </select></label>
      <p className="muted">Automatic setup needs access to this domain in the connected Cloudflare account. With external DNS management, you or your AI agent apply the required records and ask Typeroll to verify them.</p>
      <p className="muted">R2 media hosts require the domain in the same Cloudflare account as your storage. If DNS is hosted elsewhere, move the domain’s DNS to Cloudflare or use Cloudflare’s Business/Enterprise partial setup. Choosing external DNS management does not remove this requirement.</p>
      <div><button className="btn" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save domain settings'}</button></div>
    </form>}
  </section>;
}
