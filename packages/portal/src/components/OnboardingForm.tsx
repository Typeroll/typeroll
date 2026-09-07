import { useEffect, useState } from 'react';

type Tab = 'create' | 'join';

interface Props {
  /** Pre-filled invite token from URL ?invite= param. */
  prefillToken?: string;
}

export default function OnboardingForm({ prefillToken }: Props) {
  const [tab, setTab] = useState<Tab>(prefillToken ? 'join' : 'create');

  // Create org state
  const [orgName, setOrgName] = useState('');

  // Join state
  const [inviteInput, setInviteInput] = useState(prefillToken ?? '');

  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await fetch('/api/orgs/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: orgName }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string; };
      if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
      window.location.href = '/app';
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleJoin(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await fetch('/api/orgs/invite/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: inviteInput }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string; };
      if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
      window.location.href = '/app';
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      {/* Tab switcher */}
      <div style={{ display: 'flex', gap: '0.5rem', borderBottom: '1px solid var(--color-border)', paddingBottom: '0.75rem' }}>
        <button
          type="button"
          disabled={!hydrated}
          onClick={() => { setTab('create'); setError(null); }}
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            padding: '0.375rem 0.75rem',
            fontWeight: tab === 'create' ? 600 : 400,
            borderBottom: tab === 'create' ? '2px solid var(--color-primary)' : '2px solid transparent',
            color: tab === 'create' ? 'var(--color-primary)' : 'var(--color-text-muted)',
          }}
        >
          Create organization
        </button>
        <button
          type="button"
          disabled={!hydrated}
          onClick={() => { setTab('join'); setError(null); }}
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            padding: '0.375rem 0.75rem',
            fontWeight: tab === 'join' ? 600 : 400,
            borderBottom: tab === 'join' ? '2px solid var(--color-primary)' : '2px solid transparent',
            color: tab === 'join' ? 'var(--color-primary)' : 'var(--color-text-muted)',
          }}
        >
          Join with invite
        </button>
      </div>

      {/* Create org tab */}
      {tab === 'create' && (
        <form onSubmit={handleCreate} className="stack">
          <p className="muted text-sm">
            Create a new organization to start building sites. You can invite team members later.
          </p>
          <div className="field">
            <label htmlFor="org-name">Organization name</label>
            <input
              disabled={busy || !hydrated}
              id="org-name"
              type="text"
              required
              maxLength={80}
              placeholder="e.g. Acme Corp"
              value={orgName}
              onChange={(e) => setOrgName(e.target.value)}
              autoComplete="organization"
            />
          </div>
          {error && (
            <div style={{ color: 'var(--color-danger)', fontSize: '0.875rem' }}>{error}</div>
          )}
          <button
            type="submit"
            disabled={busy || !hydrated}
            className="btn"
            style={{ width: '100%', justifyContent: 'center' }}
          >
            {busy ? 'Creating…' : 'Create organization'}
          </button>
        </form>
      )}

      {/* Join tab */}
      {tab === 'join' && (
        <form onSubmit={handleJoin} className="stack">
          <p className="muted text-sm">
            Paste the invite link or code you received from an existing organization member.
          </p>
          <div className="field">
            <label htmlFor="invite-input">Invite link or code</label>
            <input
              disabled={busy || !hydrated}
              id="invite-input"
              type="text"
              required
              placeholder="https://…/onboarding?invite=… or paste code"
              value={inviteInput}
              onChange={(e) => setInviteInput(e.target.value)}
              autoComplete="off"
            />
          </div>
          {error && (
            <div style={{ color: 'var(--color-danger)', fontSize: '0.875rem' }}>{error}</div>
          )}
          <button
            type="submit"
            disabled={busy || !hydrated}
            className="btn"
            style={{ width: '100%', justifyContent: 'center' }}
          >
            {busy ? 'Joining…' : 'Join organization'}
          </button>
        </form>
      )}
    </div>
  );
}
