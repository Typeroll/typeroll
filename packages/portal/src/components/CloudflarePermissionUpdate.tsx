import { useState } from 'react';
import type { CloudflarePermissionReport } from '../lib/publishing/cloudflare-capabilities';

const CAPABILITY_TITLES: Record<string, string> = {
  analytics_provisioning: 'Create Web Analytics sites',
  analytics_reports: 'Read Analytics reports for Insights',
  redirect_rules: 'Create redirect rules for hosts such as www',
};

/**
 * One permission update for a Cloudflare account: the optional permissions this installation requests that the
 * connection lacks. A confirmation step says, before leaving for Cloudflare, that approving only grants permission
 * and enables Analytics for no Site.
 */
export default function CloudflarePermissionUpdate({ groupId, report, disabled }: { groupId: string; report: CloudflarePermissionReport; disabled?: boolean }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const update = report.permission_update;
  if (!report.connected || !update.required) return null;
  const missing = report.capabilities.filter(item => item.status === 'approval_required');
  const others = update.hosting_group_ids.length - 1;
  const account = report.account_name ?? 'this Cloudflare account';

  async function approve() {
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/orgs/publishing/cloudflare', { method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'approve_update', ...(groupId === 'default' ? {} : { hosting_group_id: groupId }) }) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.authorization_url) throw new Error(data.error || 'Could not open Cloudflare. Try again.');
      window.location.assign(data.authorization_url);
      return;
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not open Cloudflare.'); }
    setBusy(false);
  }

  const titleId = `cloudflare-permission-update-${groupId}`;
  return <section className="cloudflare-connection__update" aria-labelledby={titleId} data-cloudflare-permission-update>
    <h3 id={titleId}>Permission update available</h3>
    <p>Typeroll can do more with {account} after one approval:</p>
    <ul>{missing.map(item => <li key={item.capability}><strong>{CAPABILITY_TITLES[item.capability] ?? item.capability}</strong> — {item.enables}.</li>)}</ul>
    {!confirming ? <div className="cloudflare-connection__actions">
      <button type="button" className="btn" disabled={disabled || busy} onClick={() => setConfirming(true)}>Approve update</button>
    </div> : <div className="cloudflare-connection__confirm-update" role="group" aria-labelledby={`${titleId}-confirm`}>
      <p id={`${titleId}-confirm`}><strong>This only gives Typeroll permission in {account}.</strong> No Site starts measuring traffic and nothing is published. Analytics stays off for every Site until you enable it for the Sites you choose, under <a href="/app/settings/publishing#analytics">Analytics</a> or in a Site’s Core modules.</p>
      <p>Cloudflare asks you to approve the permissions{others > 0 ? ` once for each of the ${others + 1} connections of this Organization that use ${account}; Typeroll continues with the next one automatically` : ''}. The account, Sites and media stay connected.</p>
      <div className="cloudflare-connection__actions">
        <button type="button" className="btn" disabled={disabled || busy} onClick={() => void approve()}>{busy ? 'Opening Cloudflare…' : 'Continue to Cloudflare'}</button>
        <button type="button" className="btn btn--secondary" disabled={busy} onClick={() => setConfirming(false)}>Cancel</button>
      </div>
    </div>}
    {error && <p role="alert" className="cloudflare-connection__error">{error}</p>}
  </section>;
}
