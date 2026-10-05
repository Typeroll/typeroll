import { useEffect, useState, type FormEvent } from 'react';
import PublishingCard from './PublishingCard';
import PublishingCloudflareConnection from './PublishingCloudflareConnection';
import { CLOUDFLARE_STATUS, cloudflareCardState, readCloudflareReturn } from './cloudflare-return';
import type { CloudflareConnectionDiagnosis } from '../lib/publishing/cloudflare-diagnosis';

type Group = { id: string; name: string; revision: string; sites_domain: string | null; dns_mode: string;
  connection: { status: string; revision: string; cloudflare: { account_id?: string; account_name: string } | null };
  account_choices?: Array<{ id: string; name: string }>; cloudflare_diagnosis?: CloudflareConnectionDiagnosis };
async function request(path: string, method = 'GET', body?: unknown) {
  const response = await fetch(path, { method, cache: 'no-store', headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Could not update Hosting Groups.');
  return data;
}
const root = '/api/orgs/publishing';

export default function HostingGroups() {
  const [groups, setGroups] = useState<Group[]>([]);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ error: boolean; text: string } | null>(null);
  // Which Hosting Group the person just came back from Cloudflare for, explained inside that group's card.
  const [returned, setReturned] = useState<{ result: string; groupId: string } | null>(null);
  const [setupAvailable, setSetupAvailable] = useState(true);
  const refresh = async () => {
    const data = await request(`${root}/hosting-groups`);
    setGroups(data.groups);
    if (typeof data.cloudflare_setup?.available === 'boolean') setSetupAvailable(data.cloudflare_setup.available);
  };
  useEffect(() => {
    setReturned(readCloudflareReturn());
    void refresh().catch(error => setFeedback({ error: true, text: error.message }));
  }, []);
  async function action(work: () => Promise<unknown>, message: string) {
    setBusy(true); setFeedback(null);
    try { await work(); await refresh(); setFeedback({ error: false, text: message }); }
    catch (error) { setFeedback({ error: true, text: error instanceof Error ? error.message : 'Could not update Hosting Groups.' }); }
    finally { setBusy(false); }
  }
  function save(event: FormEvent<HTMLFormElement>, group?: Group) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = Object.fromEntries(new FormData(form));
    void action(async () => { await request(`${root}/hosting-groups`, 'POST', { ...values, ...(group ? { id: group.id, revision: group.revision } : {}) }); if (!group) form.reset(); }, group ? 'Hosting Group saved.' : 'Hosting Group created. Connect its Cloudflare hosting account next.');
  }
  return <section className="stack" style={{ maxWidth: 760, marginBottom: '1.5rem' }} aria-label="Hosting Groups">
    <h2>Hosting Groups</h2>
    <p>Default is all you need to get started. Add more groups only when you need another Cloudflare hosting account.</p>
    <p>Each group connects a hosting account and a site address base. All groups share your organization’s GitHub connection and media library.</p>
    {feedback && <p role={feedback.error ? 'alert' : 'status'}>{feedback.text}</p>}
    {groups.map(group => {
      const connected = group.connection.status === 'connected';
      return <PublishingCard key={group.id} id={`hosting-${group.id}`} title={group.name}
        state={group.id === 'default' ? 'neutral' : !connected ? (group.cloudflare_diagnosis ? cloudflareCardState(group.cloudflare_diagnosis) : 'error') : group.sites_domain ? 'ready' : 'waiting'}
        status={group.id === 'default' ? 'Uses organization settings' : !connected ? (group.cloudflare_diagnosis && group.cloudflare_diagnosis.outcome !== 'sign_in_required' ? CLOUDFLARE_STATUS[group.cloudflare_diagnosis.outcome] : 'Connect a hosting account') : `${group.connection.cloudflare?.account_name ?? 'Cloudflare connected'}${group.sites_domain ? ` · ${group.sites_domain}` : ' · Site address base not set'}`}>
        {group.id === 'default' ? <p>Created automatically. Uses the Cloudflare account and site address base configured for your organization in Publishing. No separate setup is needed here.</p> : <>
          <form onSubmit={event => save(event, group)} className="stack">
            <label className="field">Group name<input name="name" defaultValue={group.name} maxLength={80} required /></label>
            <label className="field">Site address base<input name="sites_domain" defaultValue={group.sites_domain ?? ''} placeholder="sites2.example.com" autoCapitalize="none" spellCheck={false} /></label>
            <label className="field">DNS management<select name="dns_mode" defaultValue={group.dns_mode}><option value="automatic">Use organization DNS connection</option><option value="external">My DNS provider or agent</option></select></label>
            <button className="btn" disabled={busy}>Save Hosting Group</button>
          </form>
          <details><summary>Setup instructions</summary><p>The site address base may use a domain managed by your organization’s main Cloudflare account. Typeroll creates each site’s DNS record there and builds the site on this group’s account. Media storage remains shared.</p></details>
          <PublishingCloudflareConnection groupId={group.id} connection={group.connection} diagnosis={group.cloudflare_diagnosis} choices={group.account_choices}
            available={setupAvailable} returned={returned?.groupId === group.id ? returned.result : null} disabled={busy} onRefresh={refresh} />
          {connected && <button className="btn btn--secondary" disabled={busy} onClick={() => void action(async () => {
            const result = await request(`${root}/cloudflare`, 'POST', { action: 'start', hosting_group_id: group.id });
            window.location.assign(result.authorization_url);
          }, 'Opening Cloudflare…')}>Renew Cloudflare authorization</button>}
          {connected && <details><summary>Disconnect hosting account</summary><p>Publishing will pause for sites in this group. Existing public deployments remain available.</p><button className="btn" disabled={busy} onClick={() => void action(() => request(`${root}/cloudflare`, 'DELETE', { revision: group.connection.revision, hosting_group_id: group.id }), 'Hosting account disconnected.')}>Disconnect Cloudflare</button></details>}
        </>}
      </PublishingCard>;
    })}
    <details><summary>Add Hosting Group</summary>
      <form onSubmit={event => save(event)} className="stack" style={{ marginTop: '1rem' }}>
        <label className="field">Group name<input name="name" placeholder="Hosting 2" maxLength={80} required /></label>
        <label className="field">Site address base<input name="sites_domain" placeholder="sites2.example.com" autoCapitalize="none" spellCheck={false} /></label>
        <label className="field">DNS management<select name="dns_mode"><option value="automatic">Use organization DNS connection</option><option value="external">My DNS provider or agent</option></select></label>
        <button className="btn" disabled={busy}>Create Hosting Group</button>
      </form>
    </details>
  </section>;
}

export function SiteHostingGroup({ siteId }: { siteId: string }) {
  const [data, setData] = useState<{ selected: { id: string; name: string }; groups: Array<{ id: string; name: string }> } | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const url = `/api/sites/${encodeURIComponent(siteId)}/publishing/hosting-group`;
  useEffect(() => { void request(url).then(setData).catch(error => { setError(true); setMessage(error.message); }); }, [url]);
  return <div className="stack">
    {data && data.groups.length > 1 && <form className="stack" onSubmit={async event => {
      event.preventDefault(); const groupId = new FormData(event.currentTarget).get('hosting_group_id'); setBusy(true); setMessage('');
      try { await request(url, 'PUT', { hosting_group_id: groupId, previous_group_id: data.selected.id }); setData(await request(url)); setError(false); setMessage('Hosting Group saved.'); }
      catch (error) { setError(true); setMessage(error instanceof Error ? error.message : 'Could not save Hosting Group.'); }
      finally { setBusy(false); }
    }}><label className="field">Hosting Group<select name="hosting_group_id" key={data.selected.id} defaultValue={data.selected.id}>{data.groups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}</select></label><button className="btn" disabled={busy}>Save Hosting Group</button></form>}
    {message && <p role={error ? 'alert' : 'status'}>{message}</p>}
  </div>;
}
