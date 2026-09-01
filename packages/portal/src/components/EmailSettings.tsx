// Per-site email connector config (admin only). Fully data-driven: the form
// fields are rendered from the provider schemas returned by the API, so adding
// a provider (Resend, SES, …) server-side surfaces here with no UI changes.
//
// Secrets are write-only: a stored secret shows as a mask sentinel and is only
// overwritten when the admin retypes it.

import { useEffect, useMemo, useState } from 'react';

const MASK = '••••••••';

type FieldType = 'text' | 'number' | 'boolean' | 'password';
interface ProviderField {
  key: string;
  label: string;
  type: FieldType;
  secret?: boolean;
  required?: boolean;
  placeholder?: string;
  default?: string | number | boolean;
  help?: string;
}
interface ProviderDescriptor { type: string; label: string; fields: ProviderField[] }
interface MaskedConnector {
  type: string;
  from: string;
  reply_to: string;
  config: Record<string, unknown>;
}

type Values = Record<string, string | number | boolean>;

function defaultsFor(p: ProviderDescriptor): Values {
  const v: Values = {};
  for (const f of p.fields) {
    if (f.secret) v[f.key] = '';
    else v[f.key] = (f.default ?? (f.type === 'boolean' ? false : f.type === 'number' ? 0 : '')) as never;
  }
  return v;
}

function valuesFromConnector(p: ProviderDescriptor, c: MaskedConnector): Values {
  const v: Values = {};
  for (const f of p.fields) {
    if (f.secret) {
      const stored = c.config[f.key] as { set?: boolean } | undefined;
      v[f.key] = stored?.set ? MASK : '';
    } else {
      const raw = c.config[f.key];
      v[f.key] = (raw ?? f.default ?? (f.type === 'boolean' ? false : f.type === 'number' ? 0 : '')) as never;
    }
  }
  return v;
}

export default function EmailSettings({ siteId }: { siteId: string }) {
  const [providers, setProviders] = useState<ProviderDescriptor[]>([]);
  const [type, setType] = useState<string>('');
  const [from, setFrom] = useState('');
  const [replyTo, setReplyTo] = useState('');
  const [values, setValues] = useState<Values>({});

  const [cryptoOk, setCryptoOk] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testTo, setTestTo] = useState('');
  const [testing, setTesting] = useState(false);

  const provider = useMemo(() => providers.find((p) => p.type === type), [providers, type]);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`/api/sites/${siteId}/integrations/email`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? `Load failed (${res.status})`);
        const provs: ProviderDescriptor[] = data.providers ?? [];
        setProviders(provs);
        setCryptoOk(Boolean(data.crypto_configured));
        const email: MaskedConnector | null = data.email;
        const initial = email && provs.find((p) => p.type === email.type);
        if (email && initial) {
          setType(email.type);
          setFrom(email.from);
          setReplyTo(email.reply_to);
          setValues(valuesFromConnector(initial, email));
        } else if (provs[0]) {
          setType(provs[0].type);
          setValues(defaultsFor(provs[0]));
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Load failed');
      } finally {
        setLoading(false);
      }
    })();
  }, [siteId]);

  function changeProvider(newType: string) {
    setType(newType);
    const p = providers.find((x) => x.type === newType);
    setValues(p ? defaultsFor(p) : {});
  }

  function setField(key: string, v: string | number | boolean) {
    setValues((prev) => ({ ...prev, [key]: v }));
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setMsg(null);
    try {
      const res = await fetch(`/api/sites/${siteId}/integrations/email`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, from, reply_to: replyTo, config: values }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `Save failed (${res.status})`);
      setMsg('Saved.');
      // Reflect now-stored secrets back as masked.
      if (provider && data.email) setValues(valuesFromConnector(provider, data.email));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  async function sendTest() {
    setTesting(true);
    setError(null);
    setMsg(null);
    try {
      const res = await fetch(`/api/sites/${siteId}/integrations/email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: testTo }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `Test failed (${res.status})`);
      setMsg(`Test email sent to ${testTo}.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Test failed');
    } finally {
      setTesting(false);
    }
  }

  if (loading) return <p className="muted">Loading…</p>;

  return (
    <form onSubmit={save} className="stack">
      {!cryptoOk && (
        <div className="card" style={{ borderColor: 'var(--danger, #b91c1c)' }}>
          <p className="text-sm">Server-side encryption key (<code>INTEGRATIONS_SECRET_KEY</code>) is not configured, so credentials can't be saved.</p>
        </div>
      )}
      {error && <p style={{ color: 'var(--danger, #b91c1c)' }}>{error}</p>}
      {msg && <p style={{ color: 'var(--success, #15803d)' }}>{msg}</p>}

      <div className="card stack">
        <label className="field"><span>Provider</span>
          <select value={type} onChange={(e) => changeProvider(e.target.value)}>
            {providers.map((p) => <option key={p.type} value={p.type}>{p.label}</option>)}
          </select>
        </label>
        <label className="field"><span>From</span>
          <input value={from} onChange={(e) => setFrom(e.target.value)} placeholder="Acme &lt;hello@acme.com&gt;" required />
        </label>
        <label className="field"><span>Reply-To (optional)</span>
          <input value={replyTo} onChange={(e) => setReplyTo(e.target.value)} placeholder="support@acme.com" />
        </label>

        {provider?.fields.map((f) => <Field key={f.key} field={f} value={values[f.key]} onChange={(v) => setField(f.key, v)} />)}

        <div className="row"><button type="submit" className="btn btn-primary" disabled={saving || !cryptoOk}>{saving ? 'Saving…' : 'Save connector'}</button></div>
      </div>

      <div className="card stack">
        <h2 style={{ fontSize: '1rem' }}>Send a test email</h2>
        <div className="row email-test-row" style={{ gap: '0.5rem', alignItems: 'stretch' }}>
          <input style={{ flex: 1 }} value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder="you@example.com" />
          <button type="button" className="btn" onClick={sendTest} disabled={testing || !testTo.trim()}>{testing ? 'Sending…' : 'Send test'}</button>
        </div>
        <p className="text-sm muted">Save the connector first. The test uses the stored credentials.</p>
      </div>
    </form>
  );
}

function Field({ field, value, onChange }: { field: ProviderField; value: string | number | boolean | undefined; onChange: (v: string | number | boolean) => void }) {
  const saved = field.secret && value === MASK;
  if (field.type === 'boolean') {
    return (
      <label className="row text-sm" style={{ gap: '0.4rem', alignItems: 'center' }}>
        <input type="checkbox" checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} />
        {field.label}
      </label>
    );
  }
  return (
    <label className="field">
      <span>{field.label}{field.secret && saved ? ' (saved — retype to change)' : ''}</span>
      <input
        type={field.secret ? 'password' : field.type === 'number' ? 'number' : 'text'}
        value={value == null ? '' : String(value)}
        placeholder={field.placeholder}
        autoComplete={field.secret ? 'off' : undefined}
        onFocus={(e) => { if (field.secret && e.target.value === MASK) onChange(''); }}
        onChange={(e) => onChange(field.type === 'number' ? Number(e.target.value) : e.target.value)}
      />
      {field.help && <span className="text-sm muted">{field.help}</span>}
    </label>
  );
}
