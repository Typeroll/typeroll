// Create a personal API token for scripts. The token is shown once.

import { useState } from 'react';

export default function PersonalApiToken() {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/account/api-tokens', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? `Could not create the token (${res.status})`);
      setToken(data.token);
      setName('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the token');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={create} className="card stack" aria-labelledby="api-token-heading">
      <h2 id="api-token-heading" style={{ fontSize: '1.125rem' }}>Personal API token</h2>
      <p className="text-sm muted">
        For scripts and tools that call the REST API. A token has your current access in every organization you belong
        to and lasts until you revoke it. Name the organization in each request with the <code>Typeroll-Organization</code> header.
      </p>
      <label className="field">
        <span>Token name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="Reporting script" required />
      </label>
      {error && <p className="text-sm" role="alert" style={{ color: 'var(--color-danger)' }}>{error}</p>}
      {token && (
        <div className="stack" role="status">
          <p className="text-sm"><strong>Copy this token now.</strong> It is not shown again. Reload the page to see it in your connections.</p>
          <code style={{ overflowWrap: 'anywhere' }}>{token}</code>
        </div>
      )}
      <div className="row"><button type="submit" className="btn" disabled={busy}>Create token</button></div>
    </form>
  );
}
