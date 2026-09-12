import { useEffect, useState, type FormEvent } from 'react';
import PublishingCard from './PublishingCard';

type Group = { id: string; name: string; revision: string; sites_domain: string | null; dns_mode: string;
  connection: { status: string; revision: string; cloudflare: { account_name: string } | null };
  account_choices?: Array<{ id: string; name: string }> };
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
  const refresh = async () => setGroups((await request(`${root}/hosting-groups`)).groups);
  useEffect(() => { void refresh().catch(error => setFeedback({ error: true, text: error.message })); }, []);
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
        state={group.id === 'default' ? 'neutral' : !connected ? 'error' : group.sites_domain ? 'ready' : 'waiting'}
        status={group.id === 'default' ? 'Uses organization settings' : !connected ? 'Connect a hosting account' : `${group.connection.cloudflare?.account_name ?? 'Cloudflare connected'}${group.sites_domain ? ` · ${group.sites_domain}` : ' · Site address base not set'}`}>
        {group.id === 'default' ? <p>Created automatically. Uses the Cloudflare account and site address base configured for your organization in Publishing. No separate setup is needed here.</p> : <>
          <form onSubmit={event => save(event, group)} className="stack">
            <label className="field">Group name<input name="name" defaultValue={group.name} maxLength={80} required /></label>
            <label className="field">Site address base<input name="sites_domain" defaultValue={group.sites_domain ?? ''} placeholder="sites2.example.com" autoCapitalize="none" spellCheck={false} /></label>
            <label className="field">DNS management<select name="dns_mode" defaultValue={group.dns_mode}><option value="automatic">Use organization DNS connection</option><option value="external">My DNS provider or agent</option></select></label>
            <button className="btn" disabled={busy}>Save Hosting Group</button>
          </form>
          <details><summary>Setup instructions</summary><p>The site address base may use a domain managed by your organization’s main Cloudflare account. Typeroll creates each site’s DNS record there and builds the site on this group’s account. Media storage remains shared.</p></details>
          {group.account_choices?.length ? <form onSubmit={event => {
            event.preventDefault(); const account = new FormData(event.currentTarget).get('account_id');
            void action(() => request(`${root}/cloudflare`, 'POST', { action: 'select', account_id: account, hosting_group_id: group.id }), 'Hosting account connected.');
          }} className="stack"><label className="field">Cloudflare account<select name="account_id">{group.account_choices.map(account => <option key={account.id} value={account.id}>{account.name}</option>)}</select></label><button className="btn" disabled={busy}>Use this account</button></form> : <button className="btn" disabled={busy} onClick={() => void action(async () => {
            const result = await request(`${root}/cloudflare`, 'POST', { action: 'start', hosting_group_id: group.id });
            window.location.assign(result.authorization_url);
          }, 'Opening Cloudflare…')}>{connected ? 'Renew Cloudflare authorization' : 'Connect Cloudflare'}</button>}
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
