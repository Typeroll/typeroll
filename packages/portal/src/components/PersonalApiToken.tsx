// Create a personal API token for scripts. The token is shown once. Optional
// limits narrow it to some organizations, to reads, or to a period.

import { useState } from 'react';

interface Props { organizations: Array<{ id: string; name: string }> }

export default function PersonalApiToken({ organizations }: Props) {
  const [name, setName] = useState('');
  const [limitOrgs, setLimitOrgs] = useState(false);
  const [orgIds, setOrgIds] = useState<string[]>([]);
  const [readOnly, setReadOnly] = useState(false);
  const [expiry, setExpiry] = useState('');
  const [busy, setBusy] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/account/api-tokens', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, read_only: readOnly, expires_in_days: expiry ? Number(expiry) : null, ...(limitOrgs ? { organization_ids: orgIds } : {}) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setError(data.error ?? `Could not create the token (${res.status})`); return; }
      setToken(data.token);
      setName('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the token');
    } finally {
      setBusy(false);
    }
  }

  const toggle = (id: string) => setOrgIds(ids => ids.includes(id) ? ids.filter(value => value !== id) : [...ids, id]);

  return (
    <form onSubmit={create} className="card stack" aria-labelledby="api-token-heading">
      <h2 id="api-token-heading" style={{ fontSize: '1.125rem' }}>Personal API token</h2>
      <p className="text-sm muted">
        For scripts that call the REST API on your behalf. A token has your current access, is checked on every request
        and lasts until it expires or you revoke it. Name the organization in each request with the{' '}
        <code>Typeroll-Organization</code> header. For unattended automation in one organization, an organization API key
        is the safer choice.
      </p>
      <label className="field">
        <span>Token name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="Reporting script" required />
      </label>
      <label className="row" style={{ gap: '0.5rem' }}>
        <input type="checkbox" checked={limitOrgs} onChange={(e) => setLimitOrgs(e.target.checked)} />
        <span>Only these organizations</span>
      </label>
      {limitOrgs && (
        <fieldset className="stack" style={{ border: 0, padding: 0 }}>
          <legend className="sr-only">Organizations</legend>
          {organizations.map(org => (
            <label key={org.id} className="row" style={{ gap: '0.5rem' }}>
              <input type="checkbox" checked={orgIds.includes(org.id)} onChange={() => toggle(org.id)} />
              <span>{org.name} <span className="muted">({org.id})</span></span>
            </label>
          ))}
        </fieldset>
      )}
      <label className="row" style={{ gap: '0.5rem' }}>
        <input type="checkbox" checked={readOnly} onChange={(e) => setReadOnly(e.target.checked)} />
        <span>Read only</span>
      </label>
      <label className="field">
        <span>Expires</span>
        <select value={expiry} onChange={(e) => setExpiry(e.target.value)}>
          <option value="">Never (until revoked)</option>
          <option value="30">After 30 days</option>
          <option value="90">After 90 days</option>
          <option value="365">After one year</option>
        </select>
      </label>
      {error && (
        <p className="text-sm" role="alert" style={{ color: 'var(--color-danger)' }}>{error}</p>
      )}
      {token && (
        <div className="stack" role="status">
          <p className="text-sm"><strong>Copy this token now.</strong> It is not shown again. Reload the page to see it in your list.</p>
          <code style={{ overflowWrap: 'anywhere' }}>{token}</code>
        </div>
      )}
      <div className="row"><button type="submit" className="btn" disabled={busy || (limitOrgs && !orgIds.length)}>Create token</button></div>
    </form>
  );
}
