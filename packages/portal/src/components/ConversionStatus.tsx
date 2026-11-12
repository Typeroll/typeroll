// Form conversions on the Integrations card: what is set up, a Conversions
// API test send, and the last outcomes (lib/forms/conversions.ts). No
// contact data is shown because none is stored.
import { useEffect, useState } from 'react';

interface Entry {
  at: string;
  form_id: string;
  event_id: string;
  meta_event: string | null;
  ga4_event: string | null;
  consent: string;
  browser: { meta: string; ga4: string; gtm: string };
  capi: { status: string; reason?: string; http_status?: number };
  test?: boolean;
}
interface Status {
  mode: string;
  providers: { meta_pixel: boolean; google_analytics: boolean; google_tag_manager: boolean };
  conversions_api: { token_set: boolean; test_event_code_set: boolean; email_matching: boolean };
  recent: Entry[];
}

const BROWSER: Record<string, string> = {
  fires: 'fires',
  waits_for_consent: 'waits for consent',
  not_configured: 'not set up',
  no_event: '—',
};
const CONSENT: Record<string, string> = {
  none: 'no banner',
  all: 'accepted all',
  necessary: 'necessary only',
  rejected: 'rejected',
  unset: 'not chosen',
  unknown: 'unknown (no script)',
};
const REASON: Record<string, string> = {
  no_meta_event: 'no Meta event',
  no_user_data: 'no consent, no email matching',
  already_sent: 'already sent',
};

function capiText(c: Entry['capi']): string {
  if (c.status === 'sent') return 'sent';
  if (c.status === 'off') return 'off';
  if (c.status === 'skipped') return `skipped: ${REASON[c.reason ?? ''] ?? c.reason}`;
  return `failed${c.http_status ? ` (${c.http_status})` : ''}: ${c.reason ?? ''}`;
}

export default function ConversionStatus({ siteId }: { siteId: string }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  async function load() {
    try {
      const res = await fetch(`/api/sites/${siteId}/integrations/conversions`);
      if (!res.ok) throw new Error(`Could not load (${res.status})`);
      setStatus(await res.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load');
    }
  }
  useEffect(() => { void load(); }, [siteId]);

  async function test() {
    setTesting(true);
    setNote(null);
    try {
      const res = await fetch(`/api/sites/${siteId}/integrations/conversions`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      });
      const data = await res.json();
      setNote(data.ok ? 'Test event sent. Check Events Manager → Test events.' : (data.error ?? 'The test could not be sent.'));
      await load();
    } finally {
      setTesting(false);
    }
  }

  if (error) return <p className="text-sm muted" style={{ margin: 0 }}>{error}</p>;
  if (!status) return <p className="text-sm muted" style={{ margin: 0 }}>Loading form conversions…</p>;
  const providers = [
    status.providers.meta_pixel && 'Meta Pixel',
    status.providers.google_analytics && 'GA4',
    status.providers.google_tag_manager && 'Google Tag Manager',
  ].filter(Boolean).join(', ');
  return (
    <div className="stack" data-conversion-status style={{ gap: 6, borderTop: '1px solid var(--border, #e5e7eb)', paddingTop: '0.75rem' }}>
      <p className="text-sm" style={{ margin: 0, fontWeight: 600 }}>Form conversions</p>
      <p className="text-sm muted" style={{ margin: 0 }}>
        {providers ? `Sent through ${providers}` : 'No Meta Pixel, GA4 or Google Tag Manager set up'} · mode {status.mode}
        {' · '}Conversions API {status.conversions_api.token_set ? 'on' : 'off'}
        {status.conversions_api.email_matching ? ', matching by email' : ''}
      </p>
      {status.conversions_api.token_set && status.conversions_api.test_event_code_set && (
        <div>
          <button type="button" className="btn btn-secondary" disabled={testing} onClick={() => void test()}>
            {testing ? 'Sending…' : 'Send a test conversion'}
          </button>
        </div>
      )}
      {note && <p className="text-sm" style={{ margin: 0 }}>{note}</p>}
      {status.recent.length === 0 ? (
        <p className="text-sm muted" style={{ margin: 0 }}>No form conversions yet.</p>
      ) : (
        <table className="text-sm" style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ textAlign: 'left' }}>
              <th>When</th><th>Form</th><th>Event</th><th>Cookies</th><th>Meta</th><th>GA4</th><th>GTM</th><th>Conversions API</th>
            </tr>
          </thead>
          <tbody>
            {status.recent.map((e) => (
              <tr key={e.event_id + e.at}>
                <td>{new Date(e.at).toLocaleString()}</td>
                <td>{e.test ? 'test' : e.form_id}</td>
                <td>{e.meta_event ?? e.ga4_event ?? '—'}</td>
                <td>{CONSENT[e.consent] ?? e.consent}</td>
                <td>{BROWSER[e.browser.meta] ?? e.browser.meta}</td>
                <td>{BROWSER[e.browser.ga4] ?? e.browser.ga4}</td>
                <td>{BROWSER[e.browser.gtm] ?? e.browser.gtm}</td>
                <td>{capiText(e.capi)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="text-sm muted" style={{ margin: 0 }}>
        The browser columns say what the page does for that cookie choice; whether the browser sent it is not reported back.
      </p>
    </div>
  );
}
