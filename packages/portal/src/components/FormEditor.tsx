// Per-form admin editor: metadata, a field builder for simple one-step forms,
// registry-driven admin actions, and submissions with webhook delivery status.
// Custom block content and multi-step funnels remain on the block/MCP surface.

import { useEffect, useState } from 'react';
import { Plus, Trash2, Mail, ChevronUp, ChevronDown } from 'lucide-react';

interface EmailActionConfig {
  to: string;
  cc?: string;
  bcc?: string;
  reply_to?: string;
  subject: string;
  body: string;
  include_all?: boolean;
  format?: 'html' | 'text';
}
// Config is per-type, so it can't be EmailActionConfig any more — this editor
// now renders whatever the registry declares. The email panel narrows back to
// EmailActionConfig where it needs to.
interface FormAction { id?: string; type: string; config: Record<string, unknown> }
interface FieldInfo {
  name: string;
  label: string;
  type: string;
  required: boolean;
  placeholder: string;
  options: string[];
}

interface InitialForm {
  name: string;
  submit_text: string;
  success_message: string;
  partial_ttl_days: number;
  has_steps: boolean;
  actions: FormAction[];
}

interface Props {
  siteId: string;
  formId: string;
  initialForm: InitialForm;
  fields: FieldInfo[];
  fieldsEditable: boolean;
  hasConnector: boolean;
  canWrite: boolean;
  canManageActions: boolean;
}

type Tab = 'overview' | 'email' | 'submissions';

export default function FormEditor({ siteId, formId, initialForm, fields: initialFields, fieldsEditable, hasConnector, canWrite, canManageActions }: Props) {
  const [tab, setTab] = useState<Tab>('overview');
  const [form, setForm] = useState<InitialForm>(initialForm);
  const [fields, setFields] = useState<FieldInfo[]>(initialFields);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function patch<K extends keyof InitialForm>(key: K, value: InitialForm[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function save() {
    setSaving(true);
    setError(null);
    setMsg(null);
    try {
      const res = await fetch(`/api/sites/${siteId}/forms/${encodeURIComponent(formId)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: form.name,
          submit_text: form.submit_text,
          success_message: form.success_message,
          partial_ttl_days: form.partial_ttl_days,
          ...(canManageActions ? { actions: form.actions } : {}),
          ...(fieldsEditable ? { fields } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `Save failed (${res.status})`);
      setMsg('Saved.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  // ─── Actions ────────────────────────────────────────────────────────────
  // Types come from the registry, not from this file. An app that contributes
  // an action shows up here without a change — which is the whole reason
  // /form-capabilities exists: this editor used to be able to offer only the
  // one type it was hand-coded for.
  const [caps, setCaps] = useState<{
    actions: Array<{ type: string; label: string; description?: string; admin_only: boolean; has_before: boolean; config_fields: Array<{ key: string; label: string; type: string; help?: string; default?: unknown }> }>;
  } | null>(null);
  useEffect(() => {
    fetch(`/api/sites/${siteId}/form-capabilities`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setCaps(d))
      .catch(() => { /* the email editor below still works without it */ });
  }, [siteId]);

  function addTypedAction(type: string) {
    const def = caps?.actions.find((a) => a.type === type);
    const config: Record<string, unknown> = {};
    for (const f of def?.config_fields ?? []) {
      if (f.default !== undefined) config[f.key] = f.default;
    }
    patch('actions', [...form.actions, { type, config }]);
  }
  function updateActionConfig(i: number, key: string, value: unknown) {
    patch('actions', form.actions.map((a, idx) => (idx === i
      ? { ...a, config: { ...a.config, [key]: value } }
      : a)));
  }

  // ─── Email actions ──────────────────────────────────────────────────────
  function addAction(kind: 'admin' | 'autoresponder') {
    const submitter = fields.find((f) => f.type === 'email')?.name ?? 'email';
    const action: FormAction =
      kind === 'admin'
        ? { type: 'email', config: { to: '', subject: `New submission — ${form.name}`, body: '<p>You received a new submission.</p>', include_all: true, format: 'html' } }
        : { type: 'email', config: { to: `{{${submitter}}}`, subject: 'Thanks for your message', body: '<p>Thanks — we received your message and will be in touch.</p>', format: 'html' } };
    patch('actions', [...form.actions, action]);
  }
  /** Email-only patcher; the generic one is updateActionConfig above. */
  function updateAction(i: number, cfg: Partial<EmailActionConfig>) {
    patch('actions', form.actions.map((a, idx) => (idx === i ? { ...a, config: { ...a.config, ...cfg } } : a)));
  }
  function removeAction(i: number) {
    patch('actions', form.actions.filter((_, idx) => idx !== i));
  }

  const variables = fields.map((f) => `{{${f.name}}}`).join('  ');

  function updateField(index: number, patch: Partial<FieldInfo>) {
    setFields((current) => current.map((field, i) => i === index ? { ...field, ...patch } : field));
  }
  function addField() {
    const used = new Set(fields.map((field) => field.name));
    let number = fields.length + 1;
    while (used.has(`field_${number}`)) number++;
    setFields((current) => [...current, {
      name: `field_${number}`, label: 'New field', type: 'text', required: false, placeholder: '', options: [],
    }]);
  }
  function moveField(index: number, direction: -1 | 1) {
    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= fields.length) return;
    setFields((current) => {
      const copy = [...current];
      [copy[index], copy[nextIndex]] = [copy[nextIndex]!, copy[index]!];
      return copy;
    });
  }

  return (
    <div className="stack">
      <div className="row" style={{ gap: '0.25rem', borderBottom: '1px solid var(--sb-border, #e5e5e5)', marginBottom: '1rem' }}>
        <TabButton active={tab === 'overview'} onClick={() => setTab('overview')}>Overview</TabButton>
        {canManageActions && <TabButton active={tab === 'email'} onClick={() => setTab('email')}>Actions{form.actions.length > 0 ? ` (${form.actions.length})` : ''}</TabButton>}
        <TabButton active={tab === 'submissions'} onClick={() => setTab('submissions')}>Submissions</TabButton>
      </div>

      {error && <p style={{ color: 'var(--danger, #b91c1c)' }}>{error}</p>}
      {msg && <p style={{ color: 'var(--success, #15803d)' }}>{msg}</p>}

      {tab === 'overview' && (
        <div className="stack">
          <div className="card stack">
            <label className="field"><span>Name</span>
              <input value={form.name} disabled={!canWrite} onChange={(e) => patch('name', e.target.value)} />
            </label>
            <label className="field"><span>Submit button text</span>
              <input value={form.submit_text} disabled={!canWrite} onChange={(e) => patch('submit_text', e.target.value)} />
            </label>
            <label className="field"><span>Success message</span>
              <input value={form.success_message} disabled={!canWrite} onChange={(e) => patch('success_message', e.target.value)} />
            </label>
            {form.has_steps && (
              <label className="field"><span>Partial submission retention (days)</span>
                <input type="number" min={1} value={form.partial_ttl_days} disabled={!canWrite}
                  onChange={(e) => patch('partial_ttl_days', Number(e.target.value))} />
              </label>
            )}
          </div>

          <div className="card stack">
            <h2 style={{ fontSize: '1rem' }}>Fields</h2>
            <p className="muted text-sm">
              {fieldsEditable
                ? 'Edit this single-step form here. Saving replaces its field blocks in the order shown.'
                : 'This form has custom content or multiple steps. Edit its block structure via the page/block tools; the variables are shown here.'}
            </p>
            {fields.length === 0 ? (
              <p className="muted">No fields detected.</p>
            ) : (
              fieldsEditable ? (
                <div className="stack">
                  {fields.map((f, i) => (
                    <div className="card stack" key={i} style={{ background: 'var(--surface-subtle, #fafafa)' }}>
                      <div className="row" style={{ gap: '0.35rem' }}>
                        <strong style={{ marginRight: 'auto' }}>Field {i + 1}</strong>
                        <button className="btn-icon" title="Move up" disabled={!canWrite || i === 0} onClick={() => moveField(i, -1)}><ChevronUp size={16} /></button>
                        <button className="btn-icon" title="Move down" disabled={!canWrite || i === fields.length - 1} onClick={() => moveField(i, 1)}><ChevronDown size={16} /></button>
                        <button className="btn-icon" title="Remove" disabled={!canWrite || fields.length === 1} onClick={() => setFields((current) => current.filter((_, index) => index !== i))}><Trash2 size={16} /></button>
                      </div>
                      <div className="row" style={{ gap: '0.75rem', alignItems: 'flex-start', flexWrap: 'wrap' }}>
                        <label className="field" style={{ flex: '1 1 180px' }}><span>Label</span><input disabled={!canWrite} value={f.label} onChange={(e) => updateField(i, { label: e.target.value })} /></label>
                        <label className="field" style={{ flex: '1 1 160px' }}><span>Field name</span><input disabled={!canWrite} value={f.name} onChange={(e) => updateField(i, { name: e.target.value })} /></label>
                        <label className="field" style={{ flex: '1 1 140px' }}><span>Type</span>
                          <select disabled={!canWrite} value={f.type} onChange={(e) => updateField(i, { type: e.target.value })}>
                            {['text', 'email', 'tel', 'url', 'number', 'textarea', 'select', 'radio', 'checkbox', 'gdpr_consent', 'hidden'].map((type) => <option key={type} value={type}>{type}</option>)}
                          </select>
                        </label>
                      </div>
                      {!['gdpr_consent', 'hidden'].includes(f.type) && <label className="field"><span>Placeholder</span><input disabled={!canWrite} value={f.placeholder} onChange={(e) => updateField(i, { placeholder: e.target.value })} /></label>}
                      {['select', 'radio', 'checkbox'].includes(f.type) && <label className="field"><span>Options (comma-separated)</span><input disabled={!canWrite} value={f.options.join(', ')} onChange={(e) => updateField(i, { options: e.target.value.split(',').map((v) => v.trim()).filter(Boolean) })} /></label>}
                      <label className="row text-sm" style={{ gap: '0.4rem' }}><input type="checkbox" disabled={!canWrite || f.type === 'gdpr_consent'} checked={f.required || f.type === 'gdpr_consent'} onChange={(e) => updateField(i, { required: e.target.checked })} />Required</label>
                    </div>
                  ))}
                  {canWrite && <button className="btn" style={{ alignSelf: 'flex-start' }} onClick={addField}><Plus size={16} /> Add field</button>}
                </div>
              ) : (
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <tbody>{fields.map((f) => <tr key={f.name}>
                    <td style={{ padding: '4px 12px 4px 0' }}><code>{`{{${f.name}}}`}</code></td>
                    <td style={{ padding: '4px 0' }}>{f.label}</td>
                    <td style={{ padding: '4px 0' }} className="muted text-sm">{f.type}</td>
                  </tr>)}</tbody>
                </table>
              )
            )}
          </div>
          {canWrite && <SaveBar saving={saving} onSave={save} />}
        </div>
      )}

      {tab === 'email' && canManageActions && (
        <div className="stack">
          {!hasConnector && (
            <div className="card" style={{ borderColor: 'var(--warning, #d97706)' }}>
              <p className="text-sm">
                No email connector is configured for this site, so these emails won't send yet.{' '}
                <a href={`/app/sites/${siteId}/settings/email`}>Set up a connector →</a>
              </p>
            </div>
          )}
          {fields.length > 0 && (
            <p className="text-sm muted">
              Variables: <code>{variables}</code> · use <code>{'{{field}}'}</code> (escaped) or <code>{'{{{field}}}'}</code> (raw).
            </p>
          )}

          {form.actions.map((a, i) => (a.type !== 'email' ? (
            // Any other registered type renders from its declared config
            // schema. Deliberately generic rather than another hand-written
            // panel — that is what stopped the last one from scaling.
            <div key={i} className="card stack">
              <div className="row" style={{ alignItems: 'center' }}>
                <strong style={{ marginRight: 'auto' }}>
                  {caps?.actions.find((c) => c.type === a.type)?.label ?? a.type}
                </strong>
                {caps?.actions.find((c) => c.type === a.type)?.has_before && (
                  <span className="text-sm muted" title="Runs before the submission is accepted, and can reject it">
                    can block submit
                  </span>
                )}
                {canWrite && (
                  <button className="btn-icon" title="Remove" onClick={() => removeAction(i)}><Trash2 size={16} /></button>
                )}
              </div>
              {(caps?.actions.find((c) => c.type === a.type)?.config_fields ?? []).map((f) => (
                <label className="field" key={f.key}><span>{f.label}</span>
                  {f.type === 'boolean' ? (
                    <input type="checkbox" disabled={!canWrite}
                      checked={Boolean(a.config[f.key])}
                      onChange={(e) => updateActionConfig(i, f.key, e.target.checked)} />
                  ) : (
                    <input disabled={!canWrite} type={f.type === 'password' ? 'password' : 'text'}
                      value={String(a.config[f.key] ?? '')}
                      onChange={(e) => updateActionConfig(i, f.key, e.target.value)} />
                  )}
                  {f.help && <span className="text-sm muted">{f.help}</span>}
                </label>
              ))}
              {!caps && <p className="text-sm muted">Loading this action's settings…</p>}
            </div>
          ) : (
            <div key={i} className="card stack">
              <div className="row" style={{ alignItems: 'center' }}>
                <Mail size={16} aria-hidden />
                <strong style={{ marginRight: 'auto' }}>Email #{i + 1}</strong>
                {canWrite && (
                  <button className="btn-icon" title="Remove" onClick={() => removeAction(i)}><Trash2 size={16} /></button>
                )}
              </div>
              <label className="field"><span>To (recipient or {'{{field}}'})</span>
                <input value={String(a.config.to ?? '')} disabled={!canWrite} onChange={(e) => updateAction(i, { to: e.target.value })} placeholder="you@company.com or {{email}}" />
              </label>
              <label className="field"><span>Subject</span>
                <input value={String(a.config.subject ?? '')} disabled={!canWrite} onChange={(e) => updateAction(i, { subject: e.target.value })} />
              </label>
              <label className="field"><span>Body</span>
                <textarea rows={5} value={String(a.config.body ?? '')} disabled={!canWrite} onChange={(e) => updateAction(i, { body: e.target.value })} />
              </label>
              <div className="row" style={{ gap: '1rem', flexWrap: 'wrap' }}>
                <label className="row text-sm" style={{ gap: '0.4rem' }}>
                  <input type="checkbox" checked={Boolean(a.config.include_all)} disabled={!canWrite}
                    onChange={(e) => updateAction(i, { include_all: e.target.checked })} />
                  Append all submitted values
                </label>
                <label className="row text-sm" style={{ gap: '0.4rem' }}>
                  Format
                  <select value={String(a.config.format ?? 'html')} disabled={!canWrite}
                    onChange={(e) => updateAction(i, { format: e.target.value as 'html' | 'text' })}>
                    <option value="html">HTML</option>
                    <option value="text">Plain text</option>
                  </select>
                </label>
              </div>
              <details>
                <summary className="text-sm muted">Advanced (cc, bcc, reply-to)</summary>
                <div className="stack" style={{ marginTop: '0.5rem' }}>
                  <label className="field"><span>Cc</span><input value={String(a.config.cc ?? '')} disabled={!canWrite} onChange={(e) => updateAction(i, { cc: e.target.value })} /></label>
                  <label className="field"><span>Bcc</span><input value={String(a.config.bcc ?? '')} disabled={!canWrite} onChange={(e) => updateAction(i, { bcc: e.target.value })} /></label>
                  <label className="field"><span>Reply-To</span><input value={String(a.config.reply_to ?? '')} disabled={!canWrite} onChange={(e) => updateAction(i, { reply_to: e.target.value })} /></label>
                </div>
              </details>
            </div>
          )))}

          {canWrite && (
            <div className="row" style={{ gap: '0.5rem', flexWrap: 'wrap' }}>
              <button className="btn" onClick={() => addAction('admin')}><Plus size={16} /> Admin notification</button>
              <button className="btn" onClick={() => addAction('autoresponder')}><Plus size={16} /> Autoresponder</button>

              {(caps?.actions ?? []).filter((c) => c.type !== 'email').length > 0 && (
                <label className="row text-sm" style={{ gap: '0.4rem' }}>
                  Add
                  <select
                    value=""
                    onChange={(e) => { if (e.target.value) { addTypedAction(e.target.value); e.target.value = ''; } }}
                  >
                    <option value="">Another action…</option>
                    {(caps?.actions ?? [])
                      .filter((c) => c.type !== 'email')
                      .map((c) => <option key={c.type} value={c.type}>{c.label}</option>)}
                  </select>
                </label>
              )}
            </div>
          )}
          {canWrite && <SaveBar saving={saving} onSave={save} />}
        </div>
      )}

      {tab === 'submissions' && <Submissions siteId={siteId} formId={formId} canWrite={canWrite} showWebhookStatus={canManageActions} />}
    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className="btn"
      style={{
        border: 'none', borderRadius: 0, background: 'none',
        borderBottom: active ? '2px solid var(--accent, #2563eb)' : '2px solid transparent',
        fontWeight: active ? 600 : 400,
      }}
    >{children}</button>
  );
}

function SaveBar({ saving, onSave }: { saving: boolean; onSave: () => void }) {
  return (
    <div className="row">
      <button className="btn btn-primary" onClick={onSave} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
    </div>
  );
}

// ─── Submissions viewer ────────────────────────────────────────────────────
interface SubmissionRow {
  id: string;
  data: Record<string, unknown>;
  created_at: string;
  status?: string;
  webhook_deliveries?: Array<{
    webhook_id?: string;
    status?: 'pending' | 'delivered' | 'failed';
    attempts?: number;
    response_status?: number;
    last_error?: string;
  }>;
}

function Submissions({ siteId, formId, canWrite, showWebhookStatus }: { siteId: string; formId: string; canWrite: boolean; showWebhookStatus: boolean }) {
  const [rows, setRows] = useState<SubmissionRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  async function load(after?: string) {
    setLoading(true);
    setError(null);
    try {
      const url = new URL(`/api/sites/${siteId}/forms/${encodeURIComponent(formId)}/submissions`, window.location.origin);
      if (after) url.searchParams.set('cursor', after);
      const res = await fetch(url.toString());
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `Load failed (${res.status})`);
      setRows((r) => (after ? [...r, ...data.submissions] : data.submissions));
      setCursor(data.next_cursor);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Load failed');
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  async function remove(id: string) {
    if (!confirm('Delete this submission?')) return;
    try {
      const res = await fetch(`/api/sites/${siteId}/forms/${encodeURIComponent(formId)}/submissions/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`Delete failed (${res.status})`);
      setRows((r) => r.filter((x) => x.id !== id));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed');
    }
  }

  if (loading && rows.length === 0) return <p className="muted">Loading…</p>;
  if (error) return <p style={{ color: 'var(--danger, #b91c1c)' }}>{error}</p>;
  if (rows.length === 0) return <p className="muted">No submissions yet.</p>;

  return (
    <div className="stack" style={{ gap: '0.5rem' }}>
      {rows.map((s) => (
        <div key={s.id} className="card stack" style={{ gap: '0.5rem' }}>
          <div className="row" style={{ alignItems: 'center' }}>
            <button className="btn" style={{ border: 'none', background: 'none', padding: 0, marginRight: 'auto' }}
              onClick={() => setOpen(open === s.id ? null : s.id)}>
              {new Date(s.created_at).toLocaleString()} {s.status === 'partial' && <em className="muted">(partial)</em>}
            </button>
            {showWebhookStatus && s.webhook_deliveries?.map((delivery, index) => (
              <span key={`${delivery.webhook_id}-${index}`} className="text-sm" title={delivery.last_error ?? `HTTP ${delivery.response_status ?? 'pending'}`}
                style={{ color: delivery.status === 'delivered' ? 'var(--success, #15803d)' : delivery.status === 'failed' ? 'var(--danger, #b91c1c)' : 'var(--muted, #6b7280)' }}>
                webhook: {delivery.status}
              </span>
            ))}
            {canWrite && <button className="btn-icon" title="Delete" onClick={() => remove(s.id)}><Trash2 size={16} /></button>}
          </div>
          {open === s.id && (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <tbody>
                {Object.entries(s.data ?? {}).map(([k, v]) => (
                  <tr key={k}>
                    <th align="left" style={{ padding: '4px 12px 4px 0', verticalAlign: 'top' }}>{k}</th>
                    <td style={{ padding: '4px 0' }}>{Array.isArray(v) ? v.join(', ') : String(v ?? '')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ))}
      {cursor && <button className="btn" onClick={() => load(cursor)} disabled={loading}>{loading ? 'Loading…' : 'Load more'}</button>}
    </div>
  );
}
