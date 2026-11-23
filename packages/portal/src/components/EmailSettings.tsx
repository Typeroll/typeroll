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

export default function EmailSettings({ siteId, organization = false }: { siteId?: string; organization?: boolean }) {
  const endpoint = organization ? '/api/orgs/email' : `/api/sites/${siteId}/integrations/email`;
  const [source, setSource] = useState<'site' | 'organization'>('site');
  const [organizationAvailable, setOrganizationAvailable] = useState(false);
  const [organizationFrom, setOrganizationFrom] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [dailyLimit, setDailyLimit] = useState(10);
  const [intervalMinutes, setIntervalMinutes] = useState(15);
  const [revision, setRevision] = useState('');
  const [sites, setSites] = useState<Array<{ id: string; name: string }>>([]);
  const [allowedSites, setAllowedSites] = useState<string[]>([]);
  const [ownSmtpRequired, setOwnSmtpRequired] = useState(false);
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
        const res = await fetch(endpoint);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? `Load failed (${res.status})`);
        const provs: ProviderDescriptor[] = data.providers ?? [];
        setProviders(provs);
        setCryptoOk(Boolean(data.crypto_configured));
        setOwnSmtpRequired(data.own_smtp_required === true);
        setSource(data.source === 'organization' ? 'organization' : 'site');
        setOrganizationAvailable(data.organization_email?.available === true);
        setOrganizationFrom(data.organization_email?.from ?? null);
        setConnected(Boolean(data.email));
        setDailyLimit(data.bulk_email?.daily_limit ?? 10);
        setIntervalMinutes(data.bulk_email?.minimum_interval_minutes ?? 15);
        setRevision(data.revision ?? ''); setSites(data.sites ?? []); setAllowedSites(data.allowed_site_ids ?? []);
        const email: MaskedConnector | null = organization ? data.email : 'site_email' in data ? data.site_email : data.email;
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
  }, [endpoint, organization]);

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
      const res = await fetch(endpoint, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(organization ? { type, from, reply_to: replyTo, config: values, allowed_site_ids: allowedSites, expected_revision: revision }
          : source === 'organization' ? { source, bulk_email: { daily_limit: dailyLimit, minimum_interval_minutes: intervalMinutes } }
          : { source, type, from, reply_to: replyTo, config: values, bulk_email: { daily_limit: dailyLimit, minimum_interval_minutes: intervalMinutes } }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `Save failed (${res.status})`);
      setMsg('Saved.');
      setConnected(Boolean(data.email));
      if (data.revision) setRevision(data.revision);
      // Reflect now-stored secrets back as masked.
      const saved = organization ? data.email : 'site_email' in data ? data.site_email : source === 'site' ? data.email : null;
      if (provider && saved) setValues(valuesFromConnector(provider, saved));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  async function savePolicyOrAccess() {
    setSaving(true); setError(null); setMsg(null);
    try {
      const res = await fetch(endpoint, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(organization
        ? { allowed_site_ids: allowedSites, expected_revision: revision }
        : { bulk_email: { daily_limit: dailyLimit, minimum_interval_minutes: intervalMinutes } }) });
      const data = await res.json(); if (!res.ok) throw new Error(data.error ?? 'Save failed');
      if (data.revision) setRevision(data.revision);
      setMsg(organization ? 'Site access saved. Sites still choose whether to use this account.' : 'Campaign sending limits saved. Transactional emails use a separate allowance.');
    } catch (error) { setError(error instanceof Error ? error.message : 'Save failed'); }
    finally { setSaving(false); }
  }

  async function disconnect() {
    setSaving(true); setError(null); setMsg(null);
    try {
      const res = await fetch(endpoint, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, ...(organization ? { body: JSON.stringify({ expected_revision: revision }) } : {}) });
      const data = await res.json(); if (!res.ok) throw new Error(data.error ?? 'Disconnect failed');
      if (data.revision) setRevision(data.revision);
      if (organization) setAllowedSites([]);
      setConnected(false);
      if (organization || source === 'site') { setFrom(''); setReplyTo(''); setValues(provider ? defaultsFor(provider) : {}); }
      setMsg(organization ? 'Organization account disconnected. Sites can no longer use it.' : 'Outgoing email disconnected for this site.');
    } catch (error) { setError(error instanceof Error ? error.message : 'Disconnect failed'); }
    finally { setSaving(false); }
  }

  async function sendTest() {
    setTesting(true);
    setError(null);
    setMsg(null);
    try {
      const res = await fetch(endpoint, {
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
      {ownSmtpRequired && <p role="note">During your trial, email requires your own SMTP account. Receiving form submissions and sending webhooks work without email. Typeroll does not send form emails on your behalf.</p>}
      {!cryptoOk && (
        <div className="card" style={{ borderColor: 'var(--danger, #b91c1c)' }}>
          <p className="text-sm">Server-side encryption key (<code>INTEGRATIONS_SECRET_KEY</code>) is not configured, so credentials can't be saved.</p>
        </div>
      )}
      {error && <p role="alert" style={{ color: 'var(--danger, #b91c1c)' }}>{error}</p>}
      {msg && <p role="status" style={{ color: 'var(--success, #15803d)' }}>{msg}</p>}
      <p>{connected ? 'An outgoing email account is connected.' : 'Outgoing email is disconnected.'}</p>

      {!organization && <div className="card stack">
        <label className="field"><span>Outgoing email account</span><select value={source} onChange={event => setSource(event.target.value as 'site' | 'organization')}>
          <option value="site">This site's own account</option><option value="organization" disabled={!organizationAvailable}>Organization account{organizationAvailable ? '' : ' — owner permission required'}</option>
        </select></label>
        {source === 'organization' && <p>{organizationAvailable ? `Shared sender: ${organizationFrom}. Credentials are managed by the organization owner.` : 'The organization owner has not allowed this site to use the shared account, or has withdrawn access. Choose a site account to configure another sender.'}</p>}
      </div>}

      {(organization || source === 'site') && <div className="card stack">
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
      </div>}
      {!organization && source === 'organization' && <button type="submit" className="btn btn-primary" disabled={saving || !organizationAvailable}>Use organization account</button>}

      {organization ? <section className="card stack" aria-labelledby="email-site-access">
        <h2 id="email-site-access">Sites allowed to use this account</h2>
        <p>New sites are excluded until you choose them here. Withdrawing access stops new sends through this account; a message already in progress may finish.</p>
        {sites.map(site => <label className="row" key={site.id}><input type="checkbox" checked={allowedSites.includes(site.id)} onChange={event => setAllowedSites(previous => event.target.checked ? [...new Set([...previous, site.id])] : previous.filter(id => id !== site.id))} />{site.name}</label>)}
        <div><button type="button" className="btn" disabled={saving} onClick={savePolicyOrAccess}>Save site access</button></div>
      </section> : <section className="card stack" aria-labelledby="campaign-sending-limits">
        <h2 id="campaign-sending-limits">Campaign sending limits</h2>
        <label className="field"><span>Campaign emails per day</span><input type="number" min={0} max={10000} step={1} value={dailyLimit} onChange={event => setDailyLimit(Number(event.target.value))} /></label>
        <label className="field"><span>Minimum minutes between campaign emails</span><input type="number" min={1} max={1440} step={1} value={intervalMinutes} onChange={event => setIntervalMinutes(Number(event.target.value))} /></label>
        <p>The daily allowance resets at midnight UTC and is shared by this site's apps. Transactional emails, including confirmations and edit links requested by a user, do not count toward it. A daily limit of 0 stops campaign sending.</p>
        <div><button type="button" className="btn" disabled={saving} onClick={savePolicyOrAccess}>Save sending limits</button></div>
      </section>}

      <div className="card stack">
        <h2 style={{ fontSize: '1rem' }}>Send a test email</h2>
        <div className="row email-test-row" style={{ gap: '0.5rem', alignItems: 'stretch' }}>
          <input style={{ flex: 1, minWidth: 0 }} value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder="you@example.com" />
          <button type="button" className="btn" onClick={sendTest} disabled={testing || !testTo.trim() || !connected}>{testing ? 'Sending…' : 'Send test'}</button>
        </div>
        <p className="text-sm muted">Save the connector first. The test uses the stored credentials.</p>
      </div>
      <div><button type="button" className="btn" disabled={saving} onClick={disconnect}>{organization ? 'Disconnect account for all allowed sites' : 'Disconnect outgoing email'}</button></div>
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
