// Manage public-API keys for one site. Renders the keys list + the
// "Create new key" affordance + the show-once reveal modal.
//
// The key value is shown ONLY in the modal that appears right after
// creation. Subsequent listings (from /api/sites/.../api-keys GET) never
// return the secret again — only metadata. We make this loud in the UI
// so a user who clicks "Copy" understands they can't come back later.

import { useEffect, useRef, useState } from 'react';
import { Copy, Check, KeyRound, Trash2 } from 'lucide-react';

interface ApiKeySummary {
  id: string;
  name: string;
  created_at: string;
  created_by: string;
  last_used_at?: string;
  last_used_ip?: string;
  revoked_at?: string;
}

interface Props {
  siteId: string;
  initialKeys: ApiKeySummary[];
}

export default function ApiKeyManager({ siteId, initialKeys }: Props) {
  const [keys, setKeys] = useState<ApiKeySummary[]>(initialKeys);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [newToken, setNewToken] = useState<string | null>(null);
  const [newKeyMeta, setNewKeyMeta] = useState<ApiKeySummary | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (creating) inputRef.current?.focus();
  }, [creating]);

  async function createKey(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const trimmed = name.trim();
    if (!trimmed) return;
    try {
      const res = await fetch(`/api/sites/${siteId}/api-keys`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `Create failed (${res.status})`);
      setNewToken(data.token);
      setNewKeyMeta(data.key);
      setKeys((existing) => [data.key, ...existing]);
      setName('');
      setCreating(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Create failed');
    }
  }

  async function revoke(prefix: string, label: string) {
    if (!window.confirm(`Revoke "${label}"? Any client using this key stops working immediately.`)) return;
    try {
      const res = await fetch(`/api/sites/${siteId}/api-keys/${prefix}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`Revoke failed (${res.status})`);
      const revokedAt = new Date().toISOString();
      setKeys((existing) => existing.map((k) => (k.id === prefix ? { ...k, revoked_at: revokedAt } : k)));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Revoke failed');
    }
  }

  function copyToken() {
    if (!newToken) return;
    navigator.clipboard?.writeText(newToken);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  }

  const active = keys.filter((k) => !k.revoked_at);
  const revoked = keys.filter((k) => !!k.revoked_at);

  const mcpSnippet = newToken
    ? JSON.stringify(
        {
          mcpServers: {
            typeroll: {
              command: 'npx',
              args: ['-y', '@typeroll/mcp-server'],
              env: {
                TYPEROLL_API_URL: typeof window === 'undefined' ? 'https://app.typeroll.com' : window.location.origin,
                TYPEROLL_API_KEY: newToken,
              },
            },
          },
        },
        null,
        2,
      )
    : '';

  return (
    <div className="stack">
      <div className="card stack">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <h2 style={{ fontSize: '1.125rem', margin: 0 }}>API keys</h2>
            <p className="muted text-sm" style={{ margin: '0.25rem 0 0' }}>
              For agency / power-user access via the public REST API and the{' '}
              <a href="https://www.npmjs.com/package/@typeroll/mcp-server" target="_blank" rel="noopener">
                Typeroll MCP server
              </a>
              .
            </p>
          </div>
          {!creating && (
            <button type="button" className="btn" onClick={() => setCreating(true)}>
              <KeyRound size={14} /> New key
            </button>
          )}
        </div>

        {creating && (
          <form className="row" onSubmit={createKey} style={{ gap: '0.5rem' }}>
            <input
              ref={inputRef}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Key name (e.g. Acme agency)"
              maxLength={80}
              style={{ flex: 1 }}
            />
            <button type="submit" className="btn">Create</button>
            <button type="button" onClick={() => { setCreating(false); setName(''); setError(null); }}>
              Cancel
            </button>
          </form>
        )}

        {error && <p className="text-sm" style={{ color: 'var(--color-danger)' }}>{error}</p>}

        {keys.length === 0 && !creating && (
          <p className="muted text-sm" style={{ margin: 0 }}>
            No keys yet. Create one to connect Claude Code or call the REST API directly.
          </p>
        )}

        {active.length > 0 && (
          <ul className="api-keys">
            {active.map((k) => (
              <li key={k.id} className="api-keys__row">
                <div className="api-keys__main">
                  <div className="api-keys__name">{k.name}</div>
                  <div className="api-keys__meta muted text-sm">
                    <code>typeroll_live_{k.id}_…</code>
                    {' · '}created {new Date(k.created_at).toLocaleDateString()} by {k.created_by}
                    {k.last_used_at && (
                      <> · last used {new Date(k.last_used_at).toLocaleString()}</>
                    )}
                  </div>
                </div>
                <button
                  type="button"
                  className="api-keys__revoke"
                  onClick={() => revoke(k.id, k.name)}
                  title="Revoke this key"
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
            <ul className="api-keys">
              {revoked.map((k) => (
                <li key={k.id} className="api-keys__row api-keys__row--revoked">
                  <div className="api-keys__main">
                    <div className="api-keys__name">{k.name}</div>
                    <div className="api-keys__meta muted text-sm">
                      <code>typeroll_live_{k.id}_…</code>
                      {' · '}revoked {k.revoked_at && new Date(k.revoked_at).toLocaleString()}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>

      {newToken && newKeyMeta && (
        <div className="modal-backdrop" onClick={() => setNewToken(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3 style={{ marginTop: 0 }}>Your new key — copy it now</h3>
            <p className="text-sm" style={{ color: 'var(--color-danger)' }}>
              This is the only time the full key will be shown. Once you close this dialog, the secret is unrecoverable. If you lose it, create a new key.
            </p>
            <div className="modal__key">
              <code>{newToken}</code>
              <button type="button" onClick={copyToken} className="modal__copy">
                {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? 'Copied' : 'Copy'}
              </button>
            </div>

            <h4 style={{ marginBottom: '0.25rem' }}>Use with Claude Code</h4>
            <p className="text-sm muted" style={{ margin: 0 }}>
              Add this to your <code>.claude.json</code> under <code>mcpServers</code>:
            </p>
            <pre className="modal__snippet"><code>{mcpSnippet}</code></pre>

            <h4 style={{ marginBottom: '0.25rem' }}>Or call the REST API directly</h4>
            <pre className="modal__snippet"><code>{`curl -H "Authorization: Bearer ${newToken}" \\\n  ${typeof window !== 'undefined' ? window.location.origin : 'https://app.typeroll.com'}/api/v1/sites/${siteId}/pages`}</code></pre>

            <div className="row" style={{ justifyContent: 'flex-end', marginTop: '1rem' }}>
              <button type="button" className="btn" onClick={() => setNewToken(null)}>I've saved it</button>
            </div>
          </div>
        </div>
      )}

      <style>{styles}</style>
    </div>
  );
}

const styles = `
.api-keys { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.5rem; }
.api-keys__row {
  display: flex; align-items: center; gap: 0.75rem;
  padding: 0.6rem 0.75rem;
  border: 1px solid var(--color-border); border-radius: var(--radius-md);
  background: var(--color-bg);
}
.api-keys__row--revoked { opacity: 0.55; }
.api-keys__main { flex: 1; min-width: 0; }
.api-keys__name { font-weight: 500; }
.api-keys__meta { word-break: break-all; }
.api-keys__meta code { font-family: var(--font-mono); }
.api-keys__revoke {
  background: none; border: 1px solid transparent; cursor: pointer;
  padding: 0.35rem 0.5rem; border-radius: var(--radius-sm);
  color: var(--color-text-muted);
}
.api-keys__revoke:hover { color: var(--color-danger); border-color: var(--color-danger); }
.modal-backdrop {
  position: fixed; inset: 0; background: rgba(15, 23, 42, 0.5);
  display: flex; align-items: center; justify-content: center;
  z-index: 100; padding: 1rem;
}
.modal {
  background: var(--color-surface); border-radius: var(--radius-md);
  padding: 1.5rem; max-width: 640px; width: 100%; max-height: 90vh;
  overflow-y: auto; box-shadow: var(--shadow-lg);
}
.modal__key {
  display: flex; align-items: center; gap: 0.5rem;
  padding: 0.6rem 0.75rem; background: var(--color-bg);
  border: 1px solid var(--color-border); border-radius: var(--radius-sm);
  margin: 0.5rem 0 1rem;
}
.modal__key code {
  flex: 1; min-width: 0; word-break: break-all;
  font-family: var(--font-mono); font-size: 0.85rem;
}
.modal__copy {
  display: inline-flex; align-items: center; gap: 0.35rem;
  padding: 0.3rem 0.6rem; font-size: 0.8rem; cursor: pointer;
  background: var(--color-surface); border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
}
.modal__snippet {
  background: var(--color-bg); border: 1px solid var(--color-border);
  border-radius: var(--radius-sm); padding: 0.6rem 0.75rem;
  font-family: var(--font-mono); font-size: 0.8rem;
  overflow-x: auto; max-width: 100%; margin: 0.25rem 0 1rem;
}
.modal__snippet code { white-space: pre; }
`;
