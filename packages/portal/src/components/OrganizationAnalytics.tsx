import { useEffect, useState, type FormEvent } from 'react';
import PublishingCard, { type PublishingState } from './PublishingCard';
import type { AnalyticsChangeResult, AnalyticsOverview } from '../lib/apps/analytics-overview';

const STATUS: Record<string, string> = { ready: 'On · Ready', action_required: 'On · Action needed', disabled: 'Off', error: 'Not changed' };

/**
 * Analytics for the Organization's Sites: which Sites measure traffic, their setup, and a bulk on/off. Approving
 * Cloudflare permissions enables nothing here; every Site stays off until it is chosen.
 */
export default function OrganizationAnalytics() {
  const [data, setData] = useState<AnalyticsOverview | null>(null);
  const [chosen, setChosen] = useState<Record<string, boolean>>({});
  const [results, setResults] = useState<Record<string, AnalyticsChangeResult>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  async function load() {
    const response = await fetch('/api/orgs/analytics', { cache: 'no-store' });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || 'Could not load Analytics for your Sites.');
    setData(body);
    setChosen(Object.fromEntries((body as AnalyticsOverview).sites.map(site => [site.site_id, site.enabled])));
  }
  useEffect(() => { void load().catch(failure => setError(failure.message)); }, []);

  const changes = data ? data.sites.filter(site => chosen[site.site_id] !== site.enabled).map(site => ({ site_id: site.site_id, enabled: chosen[site.site_id] })) : [];
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!changes.length) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const response = await fetch('/api/orgs/analytics', { method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sites: changes }) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || 'Could not change Analytics.');
      const list = body.results as AnalyticsChangeResult[];
      setResults(Object.fromEntries(list.map(item => [item.site_id, item])));
      const needs = list.filter(item => item.status === 'action_required' || item.status === 'error').length;
      setNotice(needs ? `Saved. ${needs} Site${needs === 1 ? '' : 's'} need${needs === 1 ? 's' : ''} an action — see below.` : 'Saved. Publish each Site you turned on to add the beacon to its pages.');
      await load();
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not change Analytics.'); }
    finally { setBusy(false); }
  }

  const sites = data?.sites ?? [];
  const on = sites.filter(site => site.enabled).length;
  const attention = sites.some(site => site.enabled && site.setup?.status === 'action_required');
  const state: PublishingState = !data ? (error ? 'error' : 'waiting') : attention ? 'error' : 'neutral';
  const missingAnalytics = (data?.cloudflare_permissions ?? []).filter(report => report.connected
    && report.capabilities.some(item => item.capability.startsWith('analytics_') && item.status === 'approval_required'));

  return <PublishingCard id="analytics" title="Analytics" state={state}
    status={!data ? (error ? 'Could not load Sites' : 'Loading…') : `${on} of ${sites.length} Site${sites.length === 1 ? '' : 's'} measured`}>
    <p>Choose which Sites measure traffic with Cloudflare Web Analytics. Approving Cloudflare permissions turns Analytics on for no Site: only the Sites you select here, or in a Site’s Core modules, get a Web Analytics site and a beacon after their next publication.</p>
    {missingAnalytics.map(report => <p key={report.hosting_group_id} data-analytics-permission={report.hosting_group_id}>
      {report.hosting_group_id === 'default' ? 'The Organization’s Cloudflare account' : `Hosting Group “${report.hosting_group_name}”`} needs one permission update before Analytics can be set up for its Sites. <a href={report.permission_update.connect_url}>Approve update</a>
    </p>)}
    {error && <p role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {data && !sites.length && <p className="muted">This Organization has no Sites yet.</p>}
    {sites.length > 0 && <form className="stack" onSubmit={event => void save(event)}>
      <fieldset style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}>
        <legend style={{ fontWeight: 600, marginBottom: 8 }}>Sites with Analytics on</legend>
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 10 }}>
          {sites.map(site => {
            const result = results[site.site_id];
            const setup = site.enabled ? site.setup : null;
            return <li key={site.site_id} data-analytics-site={site.site_id} style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
              <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', cursor: 'pointer' }}>
                <input type="checkbox" checked={Boolean(chosen[site.site_id])} disabled={busy} style={{ width: 20, height: 20, margin: '2px 0 0', flex: 'none' }}
                  onChange={event => { const checked = event.currentTarget.checked; setChosen(current => ({ ...current, [site.site_id]: checked })); }} />
                <span><strong>{site.name}</strong>{site.hosting_group_name ? <span className="muted"> · {site.hosting_group_name}</span> : null}
                  <span className="muted"> · {result ? STATUS[result.status] : !site.enabled ? 'Off' : setup?.status === 'action_required' ? 'On · Action needed' : setup?.status === 'ready' ? 'On · Ready' : 'On'}</span></span>
              </label>
              {(result?.status === 'error' || result?.status === 'action_required' ? result : setup?.status === 'action_required' ? setup : null) && (() => {
                const reason = (result?.status === 'error' || result?.status === 'action_required' ? result : setup)!;
                return <p className="text-sm" style={{ margin: '4px 0 0 30px' }}>{reason.message}{reason.next_step ? ` ${reason.next_step}` : ''}
                  {reason.settings_url && <> <a href={reason.settings_url}>Open →</a></>}</p>;
              })()}
            </li>;
          })}
        </ul>
      </fieldset>
      <div><button type="submit" className="btn" disabled={busy || !changes.length}>{busy ? 'Saving…' : changes.length ? `Save changes for ${changes.length} Site${changes.length === 1 ? '' : 's'}` : 'No changes'}</button></div>
    </form>}
  </PublishingCard>;
}
