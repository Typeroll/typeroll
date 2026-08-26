// Manage cross-org shares for a single site. Renders the current grants,
// the "Grant access to another organization" form, and per-row actions
// (change permission, revoke). Owner-org admins only — the API gates with
// requirePermission('admin') and would 403 if a write-shared user reached
// this UI, but the settings page also withholds the link from non-admins.

import { useEffect, useRef, useState } from 'react';
import { Share2, Trash2 } from 'lucide-react';

type SharePermission = 'read' | 'write' | 'admin';

interface ShareRow {
  id: string;
  site_id: string;
  owner_org_id: string;
  shared_with_org_id: string;
  permission: SharePermission;
  created_at: number;
  created_by: string;
  revoked_at?: number | null;
  label?: string;
}

interface Props {
  siteId: string;
  initialShares: ShareRow[];
}

export default function SharingManager({ siteId, initialShares }: Props) {
  const [shares, setShares] = useState<ShareRow[]>(initialShares);
  const [creating, setCreating] = useState(false);
  const [orgInput, setOrgInput] = useState('');
  const [orgInputMode, setOrgInputMode] = useState<'slug' | 'id'>('slug');
  const [permission, setPermission] = useState<SharePermission>('write');
  const [label, setLabel] = useState('');
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (creating) inputRef.current?.focus();
  }, [creating]);

  async function createShare(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const trimmed = orgInput.trim();
    if (!trimmed) return;
    try {
      const body: Record<string, string> = { permission };
      if (orgInputMode === 'slug') body.org_slug = trimmed;
      else body.org_id = trimmed;
      if (label.trim()) body.label = label.trim();
      const res = await fetch(`/api/sites/${siteId}/shares`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `Create failed (${res.status})`);
      setShares((existing) => [data.share, ...existing]);
      setOrgInput('');
      setLabel('');
      setCreating(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Create failed');
    }
  }

  async function changePermission(shareId: string, newPerm: SharePermission) {
    try {
      const res = await fetch(`/api/sites/${siteId}/shares/${shareId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ permission: newPerm }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `Update failed (${res.status})`);
      setShares((existing) =>
        existing.map((s) => (s.id === shareId ? { ...s, permission: newPerm } : s)),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Update failed');
    }
  }

  async function revoke(shareId: string, label: string) {
    if (!window.confirm(`Revoke access for "${label}"? They lose access immediately.`)) return;
    try {
      const res = await fetch(`/api/sites/${siteId}/shares/${shareId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`Revoke failed (${res.status})`);
      const revokedAt = Date.now();
      setShares((existing) =>
        existing.map((s) => (s.id === shareId ? { ...s, revoked_at: revokedAt } : s)),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Revoke failed');
    }
  }

  const active = shares.filter((s) => !s.revoked_at);
  const revoked = shares.filter((s) => !!s.revoked_at);

  return (
    <div className="stack">
      <div className="card stack">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <h2 style={{ fontSize: '1.125rem', margin: 0 }}>Sharing</h2>
            <p className="muted text-sm" style={{ margin: '0.25rem 0 0' }}>
              Grant another organization access to this site without adding their users to your org.
            </p>
          </div>
          {!creating && (
            <button type="button" className="btn" onClick={() => setCreating(true)}>
              <Share2 size={14} /> Grant access
            </button>
          )}
        </div>

        {creating && (
          <form className="stack" onSubmit={createShare}>
            <div className="row" style={{ gap: '0.5rem', alignItems: 'flex-end' }}>
              <div className="field" style={{ flex: 1, margin: 0 }}>
                <label>Organization {orgInputMode}</label>
                <input
                  ref={inputRef}
                  value={orgInput}
                  onChange={(e) => setOrgInput(e.target.value)}
                  placeholder={orgInputMode === 'slug' ? 'acme-corp' : 'org_id'}
                />
              </div>
              <div className="field" style={{ margin: 0 }}>
                <label>Lookup by</label>
                <select
                  value={orgInputMode}
                  onChange={(e) => setOrgInputMode(e.target.value as 'slug' | 'id')}
                >
                  <option value="slug">Slug</option>
                  <option value="id">Org ID</option>
                </select>
              </div>
              <div className="field" style={{ margin: 0 }}>
                <label>Permission</label>
                <select value={permission} onChange={(e) => setPermission(e.target.value as SharePermission)}>
                  <option value="read">Read</option>
                  <option value="write">Write</option>
                  <option value="admin">Admin</option>
                </select>
              </div>
            </div>
            <div className="field" style={{ margin: 0 }}>
              <label>Label (optional)</label>
              <input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="Acme Corp client review"
              />
            </div>
            <div className="row" style={{ gap: '0.5rem' }}>
              <button type="submit" className="btn">Grant</button>
              <button
                type="button"
                onClick={() => {
                  setCreating(false);
                  setOrgInput('');
                  setLabel('');
                  setError(null);
                }}
              >
                Cancel
              </button>
            </div>
          </form>
        )}

        {error && <p className="text-sm" style={{ color: 'var(--color-danger)' }}>{error}</p>}

        {shares.length === 0 && !creating && (
          <p className="muted text-sm" style={{ margin: 0 }}>
            No shares yet. Grant access to give another organization read, write, or admin permission on this site.
          </p>
        )}

        {active.length > 0 && (
          <ul className="shares">
            {active.map((s) => (
              <li key={s.id} className="shares__row">
                <div className="shares__main">
                  <div className="shares__name">
                    {s.label ?? <code>{s.shared_with_org_id}</code>}
                  </div>
                  <div className="shares__meta muted text-sm">
                    org <code>{s.shared_with_org_id}</code>
                    {' · '}granted {new Date(s.created_at).toLocaleDateString()}
                  </div>
                </div>
                <select
                  value={s.permission}
                  onChange={(e) => changePermission(s.id, e.target.value as SharePermission)}
                  className="shares__perm"
                >
                  <option value="read">Read</option>
                  <option value="write">Write</option>
                  <option value="admin">Admin</option>
                </select>
                <button
                  type="button"
                  className="shares__revoke"
                  onClick={() => revoke(s.id, s.label ?? s.shared_with_org_id)}
                  title="Revoke this share"
                >
                  <Trash2 size={14} />
                </button>
              </li>
            ))}
          </ul>
        )}

        {revoked.length > 0 && (
          <details>
            <summary className="muted text-sm">Revoked ({revoked.length})</summary>
            <ul className="shares">
              {revoked.map((s) => (
                <li key={s.id} className="shares__row shares__row--revoked">
                  <div className="shares__main">
                    <div className="shares__name">
                      {s.label ?? <code>{s.shared_with_org_id}</code>}
                    </div>
                    <div className="shares__meta muted text-sm">
                      <code>{s.permission}</code>
                      {' · revoked '}
                      {s.revoked_at && new Date(s.revoked_at).toLocaleString()}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>

      <style>{styles}</style>
    </div>
  );
}

const styles = `
.shares { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.5rem; }
.shares__row {
  display: flex; align-items: center; gap: 0.75rem;
  padding: 0.6rem 0.75rem;
  border: 1px solid var(--color-border); border-radius: var(--radius-md);
  background: var(--color-bg);
}
.shares__row--revoked { opacity: 0.55; }
.shares__main { flex: 1; min-width: 0; }
.shares__name { font-weight: 500; }
.shares__meta { word-break: break-all; }
.shares__meta code { font-family: var(--font-mono); }
.shares__perm { padding: 0.25rem 0.5rem; }
.shares__revoke {
  background: none; border: 1px solid transparent; cursor: pointer;
  padding: 0.35rem 0.5rem; border-radius: var(--radius-sm);
  color: var(--color-text-muted);
}
.shares__revoke:hover { color: var(--color-danger); border-color: var(--color-danger); }
`;
