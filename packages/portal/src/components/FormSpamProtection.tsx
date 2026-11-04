// Cloudflare Turnstile for the site's forms (admins only). The secret key is
// write-only: the server checks it with Cloudflare, encrypts it and only ever
// reports that one is set.

import { useState } from 'react';

export interface SpamProtectionState {
  provider: 'turnstile' | null;
  site_key: string | null;
  secret_key: { set: boolean } | null;
  updated_at: string | null;
  crypto_configured: boolean;
  enforced_forms: Array<{ form_id: string; enforced_at: string }>;
}

interface Props {
  siteId: string;
  initial: SpamProtectionState;
  formNames: Record<string, string>;
}

export default function FormSpamProtection({ siteId, initial, formNames }: Props) {
  const [state, setState] = useState(initial);
  const [siteKey, setSiteKey] = useState(initial.site_key ?? '');
  const [secretKey, setSecretKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const endpoint = `/api/sites/${siteId}/form-spam-protection`;

  async function call(method: 'PUT' | 'DELETE', body?: unknown) {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(endpoint, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
      setState(data);
      setSiteKey(data.site_key ?? '');
      setSecretKey('');
      return true;
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : 'Request failed' });
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const keepSecret = state.site_key === siteKey.trim() && !secretKey.trim();
    if (await call('PUT', { provider: 'turnstile', site_key: siteKey.trim(), ...(keepSecret ? {} : { secret_key: secretKey.trim() }) })) {
      setMessage({ ok: true, text: 'Saved. Publish the site to show the check on its forms.' });
    }
  }

  async function remove() {
    if (!confirm('Turn off Turnstile for this site’s forms? Publish the site afterwards to remove the check from its pages.')) return;
    if (await call('DELETE')) setMessage({ ok: true, text: 'Turnstile is off. Publish the site to remove the check from its pages.' });
  }

  const enabled = state.provider === 'turnstile';
  return (
    <form onSubmit={save} className="card stack" aria-labelledby="form-spam-heading">
      <h2 id="form-spam-heading" style={{ fontSize: '1rem' }}>Spam protection</h2>
      <p className="text-sm muted">
        Cloudflare Turnstile stops bots that fill in forms in a real browser. Most visitors pass without doing anything.
        In your Cloudflare dashboard, open <strong>Turnstile → Add widget</strong>, choose <strong>Managed</strong>, add
        this site’s domain, and paste the widget’s keys here. Then publish the site.
      </p>
      {!state.crypto_configured && <p className="text-sm" role="alert" style={{ color: 'var(--color-danger)' }}>This server cannot store secrets yet. Ask its operator to configure secret encryption.</p>}
      <label className="field">
        <span>Site key</span>
        <input value={siteKey} onChange={(e) => setSiteKey(e.target.value)} autoCapitalize="none" spellCheck={false} placeholder="0x4AAAAAAA…" required />
      </label>
      <label className="field">
        <span>Secret key</span>
        <input type="password" value={secretKey} onChange={(e) => setSecretKey(e.target.value)} autoComplete="off" spellCheck={false}
          placeholder={enabled && state.site_key === siteKey.trim() ? 'Stored — leave empty to keep it' : '0x4AAAAAAA…'} required={!(enabled && state.site_key === siteKey.trim())} />
      </label>
      <p className="text-sm muted">
        {enabled
          ? `On${state.updated_at ? ` since ${new Date(state.updated_at).toLocaleDateString()}` : ''}. ${state.enforced_forms.length
            ? `Required on: ${state.enforced_forms.map(entry => formNames[entry.form_id] ?? entry.form_id).join(', ')}.`
            : 'Each form starts requiring the check after its republished pages send the first verified answer.'}`
          : 'Off. Forms are protected by a signed token, a hidden honeypot field and a rate limit.'}
      </p>
      {message && <p className="text-sm" role="status" style={message.ok ? undefined : { color: 'var(--color-danger)' }}>{message.text}</p>}
      <div className="row">
        <button type="submit" className="btn" disabled={busy || !state.crypto_configured}>Save Turnstile keys</button>
        {enabled && <button type="button" className="btn btn--secondary" disabled={busy} onClick={remove}>Turn off</button>}
      </div>
    </form>
  );
}
