import { useEffect, useState } from 'react';
interface Route { route_id: string; alias: string; target: string; revision: string; enabled: boolean; last_receipt?: { status: string; reason?: string; delivery?: { status: string } } | null }
export default function InboundEmailSettings({ siteId }: { siteId: string }) {
  const [routes, setRoutes] = useState<Route[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const endpoint = `/api/sites/${encodeURIComponent(siteId)}/integrations/inbound-email`;
  useEffect(() => {
    let active = true;
    fetch(endpoint).then(async response => {
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? 'Could not load forwarding settings.');
      if (active) setRoutes(result.routes);
    }).catch(error => { if (active) setError(error.message); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [endpoint]);
  async function toggle(route: Route) {
    setBusy(true); setError(''); setMessage('');
    try {
      const response = await fetch(endpoint, { method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ route_id: route.route_id, revision: route.revision, enabled: !route.enabled }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? 'Could not save forwarding settings.');
      setRoutes(result.routes); setMessage('Forwarding settings saved. Your Reply-To address has not changed.');
    } catch (error) { setError(error instanceof Error ? error.message : 'Could not save forwarding settings.'); }
    finally { setBusy(false); }
  }
  return <section style={{ marginTop: '2rem', overflowWrap: 'anywhere' }}>
    <h2>Incoming email &amp; forwarding</h2>
    <p>Forward incoming replies to an approved address. Messages are checked for spam, viruses and sender authentication. Uncertain messages are held for review and trigger an alert.
      Only text is forwarded; attachments are omitted. Automatic text forwarding supports messages up to 10 MiB; larger messages trigger an alert.</p>
    {error && <p role="alert">{error}</p>}
    {message && <p role="status">{message}</p>}
    {loading ? <p>Loading forwarding settings…</p> : routes.length === 0 ?
      <p>No approved receiving addresses. Ask your hosting administrator to verify the receiving domain and forwarding destination first.</p> : routes.map(route =>
        <div key={route.route_id} className="card" style={{ padding: '1rem', marginBottom: '1rem' }}>
          <p><strong>{route.alias}</strong> → {route.target}</p>
          <p>{route.enabled ? 'Forwarding enabled' : 'Forwarding disabled'}</p>
          {route.last_receipt && <p>Last message: {route.last_receipt.delivery?.status ?? route.last_receipt.status}
            {route.last_receipt.reason ? ` (${route.last_receipt.reason.replaceAll('_', ' ')})` : ''}.
            {['unknown', 'processing'].includes(route.last_receipt.status) && ' Delivery is not confirmed. Contact your administrator; do not resend automatically.'}
          </p>}
          <button type="button" className="btn" disabled={busy} onClick={() => toggle(route)}>{route.enabled ? 'Disable forwarding' : 'Enable forwarding'}</button>
        </div>)}
    <p>Enable forwarding, verify receipt and delivery with a test, then update Reply-To above.
      This does not create a mailbox or let you send from this address in your usual email app.</p>
  </section>;
}
