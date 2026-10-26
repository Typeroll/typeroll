import { useState } from 'react';
export default function PublishingDomainOnboarding({ siteId }: { siteId: string }) {
  const [zone, setZone] = useState(''), [result, setResult] = useState<any>(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [confirmed, setConfirmed] = useState(false);
  async function run(action: string) {
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/orgs/publishing/domain-onboarding', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ site_id: siteId, zone_name: zone, action, plan_revision: result?.revision, confirm_inventory: confirmed }) });
      const body = await response.json(); if (!response.ok) throw new Error(body.error || 'DNS onboarding failed.');
      setResult(body); setConfirmed(false); window.dispatchEvent(new Event('typeroll:site-domains-changed'));
    } catch (err) { setError(err instanceof Error ? err.message : 'DNS onboarding failed.'); }
    finally { setBusy(false); }
  }
  return <details>
    <summary>Add this domain to the hosting account</summary>
    <div className="stack" style={{ paddingBlock: '1rem' }}>
      <p>An organization owner or administrator can copy existing DNS into a new Cloudflare zone. Keep your current nameservers until every record has been reviewed.</p>
      <label className="field">Domain zone<input value={zone} onChange={event => { setZone(event.target.value); setResult(null); setConfirmed(false); }} placeholder="example.com" autoCapitalize="none" spellCheck={false} /></label>
      {error && <p role="alert">{error}</p>}{result?.message && <p role="status">{result.message}</p>}
      {result?.zone && <p>Zone: <strong>{result.zone.name}</strong> · {result.zone.status}<br />Assigned nameservers: {(result.zone.name_servers ?? []).join(', ') || 'Waiting for assignment'}</p>}
      {!result && <button type="button" className="btn" disabled={busy || !zone} onClick={() => void run('create_zone')}>Create or find zone</button>}
      {result?.next_action === 'scan_dns' && <button type="button" className="btn" disabled={busy} onClick={() => void run('scan_dns')}>Scan existing DNS</button>}
      {(result?.next_action === 'review_dns' || result?.comparisons) && <button type="button" className="btn" disabled={busy} onClick={() => void run('review_dns')}>Review discovered records</button>}
      {result?.comparisons && <>
        <p>{result.warning}</p>
        <div role="region" aria-label="DNS record comparison" tabIndex={0} style={{ overflowX: 'auto', maxWidth: '100%' }}><table>
          <thead><tr><th>Type</th><th>Name</th><th>Import value (DNS only)</th><th>Current public answer</th></tr></thead>
          <tbody>{result.comparisons.map((item: any, index: number) => <tr key={index}><td>{item.record.type}</td><td>{item.record.name}</td><td style={{ overflowWrap: 'anywhere' }}>{item.record.content}</td><td style={{ overflowWrap: 'anywhere' }}>{item.lookup === 'answered' ? JSON.stringify(item.current_public_answers) : item.lookup}</td></tr>)}</tbody>
        </table></div>
        {!result.comparisons.length && <p>No records discovered yet. Wait briefly and review again. Do not change nameservers based on an empty scan.</p>}
        {!!result.conflicts?.length && <p role="alert">Some discovered records conflict with existing zone records. No conflicting record will be overwritten. Review them with your DNS administrator.</p>}
        <label><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} /> I compared the complete inventory with my old DNS provider, including mail, SPF, DKIM and DMARC. Nothing required is missing.</label>
        <button type="button" className="btn" disabled={busy || !confirmed || !result.comparisons.length || !!result.conflicts?.length} onClick={() => void run('apply_dns')}>Copy reviewed records as DNS only</button>
      </>}
    </div>
  </details>;
}
