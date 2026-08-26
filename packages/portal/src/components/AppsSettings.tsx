// Per-site core modules (admin only). Historical storage and API paths still
// use "apps" for backward compatibility; this UI must not call these modules
// "Typeroll Apps", which is the separate premium product family.

import { useEffect, useState } from 'react';

const MASK = '••••••••';

interface AppField {
  key: string;
  label: string;
  type: 'text' | 'password' | 'boolean' | 'number' | 'select' | 'json';
  secret?: boolean;
  required?: boolean;
  placeholder?: string;
  help?: string;
  options?: string[];
}
interface AppState {
  enabled: boolean;
  enabled_at?: string;
  config: Record<string, unknown>;
}
interface AppEntry {
  id: string;
  name: string;
  description: string;
  category: string;
  affects_build: boolean;
  fields: AppField[];
  state: AppState;
}

function valuesFromState(fields: AppField[], s: AppState): Record<string, string> {
  const v: Record<string, string> = {};
  for (const f of fields) {
    if (f.secret) {
      const stored = s.config[f.key] as { set?: boolean } | undefined;
      v[f.key] = stored?.set ? MASK : '';
    } else {
      const value = s.config[f.key];
      v[f.key] = f.type === 'json'
        ? JSON.stringify(value ?? [], null, 2)
        : String(value ?? '');
    }
  }
  return v;
}

export default function AppsSettings({ siteId }: { siteId: string }) {
  const [apps, setApps] = useState<AppEntry[]>([]);
  const [values, setValues] = useState<Record<string, Record<string, string>>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ id: string; text: string; error?: boolean } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/sites/${siteId}/apps`)
      .then((r) => r.json())
      .then((data: { apps: AppEntry[] }) => {
        setApps(data.apps);
        const v: Record<string, Record<string, string>> = {};
        for (const a of data.apps) v[a.id] = valuesFromState(a.fields, a.state);
        setValues(v);
      })
      .finally(() => setLoading(false));
  }, [siteId]);

  async function save(app: AppEntry, enabled: boolean): Promise<void> {
    setBusy(app.id);
    setMsg(null);
    // Only send fields the user actually changed (skip the mask sentinel).
    const config: Record<string, string> = {};
    for (const f of app.fields) {
      const val = values[app.id]?.[f.key] ?? '';
      if (f.secret && val === MASK) continue;
      if (val !== '') config[f.key] = val;
    }
    try {
      const res = await fetch(`/api/sites/${siteId}/apps/${app.id}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled, config }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `Save failed (${res.status})`);
      setApps((prev) => prev.map((a) => (a.id === app.id ? { ...a, state: data.state } : a)));
      setValues((prev) => ({ ...prev, [app.id]: valuesFromState(app.fields, data.state) }));
      setMsg({
        id: app.id,
        text: enabled
          ? (app.affects_build ? 'Enabled. Redeploy the site to activate it.' : 'Enabled.')
          : 'Disabled.',
      });
    } catch (e) {
      setMsg({ id: app.id, text: (e as Error).message, error: true });
    } finally {
      setBusy(null);
    }
  }

  if (loading) return <p className="muted">Loading modules…</p>;

  return (
    <div className="stack" style={{ gap: '1rem' }}>
      {apps.map((app) => {
        const enabled = app.state.enabled;
        return (
          <div key={app.id} className="card stack" style={{ gap: '0.75rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem' }}>
              <div>
                <h2 style={{ fontSize: '1.05rem', margin: 0 }}>
                  {app.name}{' '}
                  <span className={`badge ${enabled ? 'badge--on' : 'badge--off'}`} style={{ fontSize: '.7rem' }}>
                    {enabled ? 'On' : 'Off'}
                  </span>
                </h2>
                <p className="muted text-sm" style={{ margin: '0.25rem 0 0', maxWidth: 620 }}>{app.description}</p>
              </div>
              <button
                type="button"
                className={enabled ? 'btn btn--ghost' : 'btn btn--primary'}
                disabled={busy === app.id}
                onClick={() => void save(app, !enabled)}
              >
                {busy === app.id ? '…' : enabled ? 'Disable' : 'Enable'}
              </button>
            </div>

            {enabled && app.fields.length > 0 && (
              <div className="stack" style={{ gap: '0.6rem', borderTop: '1px solid var(--border, #e5e7eb)', paddingTop: '0.75rem' }}>
                {app.fields.map((f) => (
                  <label key={f.key} className="stack" style={{ gap: 2 }}>
                    <span className="text-sm" style={{ fontWeight: 600 }}>{f.label}</span>
                    {f.type === 'json' ? (
                      <textarea
                        rows={14}
                        spellCheck={false}
                        placeholder={f.placeholder}
                        value={values[app.id]?.[f.key] ?? ''}
                        onChange={(e) =>
                          setValues((prev) => ({ ...prev, [app.id]: { ...prev[app.id], [f.key]: e.target.value } }))
                        }
                        style={{ fontFamily: 'var(--font-mono, monospace)' }}
                      />
                    ) : f.type === 'boolean' ? (
                      <input
                        type="checkbox"
                        checked={values[app.id]?.[f.key] === 'true'}
                        onChange={(e) =>
                          setValues((prev) => ({ ...prev, [app.id]: { ...prev[app.id], [f.key]: String(e.target.checked) } }))
                        }
                      />
                    ) : (
                      <input
                        type={f.secret ? 'password' : f.type === 'number' ? 'number' : 'text'}
                        placeholder={f.placeholder}
                        value={values[app.id]?.[f.key] ?? ''}
                        onChange={(e) =>
                          setValues((prev) => ({ ...prev, [app.id]: { ...prev[app.id], [f.key]: e.target.value } }))
                        }
                      />
                    )}
                    {f.help && <span className="muted text-sm">{f.help}</span>}
                  </label>
                ))}
                <div>
                  <button type="button" className="btn" disabled={busy === app.id} onClick={() => void save(app, true)}>
                    Save settings
                  </button>
                </div>
              </div>
            )}

            {enabled && app.id === 'analytics' && (
              <p className="text-sm muted" style={{ margin: 0 }}>
                <a href={`/app/sites/${siteId}/insights`}>Open the Insights dashboard →</a>
              </p>
            )}

            {msg?.id === app.id && (
              <p className="text-sm" style={{ margin: 0, color: msg.error ? 'var(--danger, #dc2626)' : 'var(--success, #16a34a)' }}>
                {msg.text}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}
