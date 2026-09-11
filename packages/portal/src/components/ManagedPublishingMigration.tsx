import { useState } from 'react';

interface Plan { state: 'ready' | 'migrated'; revision?: string; binding?: { project: string; website_host: string }; message?: string }
export default function ManagedPublishingMigration({ siteId }: { siteId: string }) {
  const [plan, setPlan] = useState<Plan | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function check(migrate = false) {
    setBusy(true); setError('');
    try {
      const response = await fetch(`/api/sites/${encodeURIComponent(siteId)}/publishing/managed-migration`, migrate ? {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: plan?.revision }),
      } : { cache: 'no-store' });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not check publishing migration. Please retry.');
      setPlan(result);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not check publishing migration. Please retry.'); }
    finally { setBusy(false); }
  }
  return <div className="stack">
    <h3>Move this site to connected publishing</h3>
    <p>Use your organization’s GitHub account and shared build engine while keeping this site’s existing Cloudflare hosting and domain. Connect the accounts in Publishing first.</p>
    {error && <p role="alert">{error}</p>}
    {plan?.state === 'migrated' ? <div role="status"><p>Publishing settings saved. This site now uses connected publishing. Its current website stays live. Wait for any media transfer to finish, then publish to deploy the new build.</p><a className="btn" href={`/app/sites/${encodeURIComponent(siteId)}/settings`}>Show updated site settings</a></div> : <>
      {plan?.state === 'ready' && <div role="status"><p>{plan.message}</p><p>Website: <strong>{plan.binding?.website_host}</strong><br />Hosting project: <strong>{plan.binding?.project}</strong></p></div>}
      <div><button type="button" className="btn" disabled={busy} onClick={() => check(plan?.state === 'ready')}>{busy ? 'Checking…' : plan?.state === 'ready' ? 'Migrate this site' : 'Check migration'}</button></div>
    </>}
  </div>;
}
