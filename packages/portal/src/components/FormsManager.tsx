// Forms list + create/delete for the portal Forms admin area. Per-form editing
// (simple fields, actions, submissions) lives on the form detail page.

import { useState } from 'react';
import { Inbox, Trash2, Plus, Mail } from 'lucide-react';

interface FormRow {
  id: string;
  name: string;
  kind: string;
  field_count: number;
  step_count: number;
  has_steps: boolean;
  action_count: number;
  submission_count: number;
  created_at: string;
}

interface Props {
  siteId: string;
  initialForms: FormRow[];
  canWrite: boolean;
}

const ID_RE = /^[a-z][a-z0-9_-]{0,62}$/;

export default function FormsManager({ siteId, initialForms, canWrite }: Props) {
  const [forms, setForms] = useState<FormRow[]>(initialForms);
  const [creating, setCreating] = useState(false);
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function createForm(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const fid = id.trim();
    if (!ID_RE.test(fid)) {
      setError('id must be lowercase, start with a letter, [a-z0-9_-]');
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/sites/${siteId}/forms`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: fid,
          name: name.trim() || fid,
          // A form needs at least one field; seed a sensible default the admin
          // can rename in the form's simple field builder.
          fields: [{ name: 'email', type: 'email', label: 'Email', required: true }],
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `Create failed (${res.status})`);
      window.location.href = `/app/sites/${siteId}/forms/${fid}`;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Create failed');
      setBusy(false);
    }
  }

  async function deleteForm(formId: string) {
    if (!confirm(`Delete form "${formId}"? Submissions are kept unless you confirm again.`)) return;
    const alsoSubs = confirm('Also delete its submissions? OK = delete submissions too, Cancel = keep them.');
    try {
      const res = await fetch(
        `/api/sites/${siteId}/forms/${encodeURIComponent(formId)}${alsoSubs ? '?delete_submissions=true' : ''}`,
        { method: 'DELETE' },
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `Delete failed (${res.status})`);
      }
      setForms((f) => f.filter((x) => x.id !== formId));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed');
    }
  }

  return (
    <div className="stack">
      {error && <p style={{ color: 'var(--danger, #b91c1c)' }}>{error}</p>}

      {forms.length === 0 && <p className="muted">No forms yet.</p>}

      <div className="stack" style={{ gap: '0.5rem' }}>
        {forms.map((f) => (
          <div key={f.id} className="card" style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <Inbox size={18} aria-hidden />
            <a href={`/app/sites/${siteId}/forms/${f.id}`} style={{ fontWeight: 600 }}>{f.name}</a>
            <span className="muted text-sm">{f.id}</span>
            <span className="text-sm muted" style={{ marginLeft: 'auto' }}>
              {f.submission_count} submission{f.submission_count === 1 ? '' : 's'}
              {` · ${f.field_count} field${f.field_count === 1 ? '' : 's'}`}
              {f.step_count > 1 && ` · ${f.step_count} steps`}
              {f.action_count > 0 && (
                <span title={`${f.action_count} email action(s)`} style={{ marginLeft: '0.4rem' }}>
                  <Mail size={14} aria-hidden style={{ verticalAlign: 'middle' }} /> {f.action_count}
                </span>
              )}
            </span>
            {canWrite && (
              <button className="btn-icon" title="Delete form" onClick={() => deleteForm(f.id)}>
                <Trash2 size={16} aria-hidden />
              </button>
            )}
          </div>
        ))}
      </div>

      {canWrite && (
        creating ? (
          <form onSubmit={createForm} className="card stack" style={{ maxWidth: 480 }}>
            <h2 style={{ fontSize: '1rem' }}>New form</h2>
            <label className="field">
              <span>ID (URL-safe, immutable)</span>
              <input value={id} onChange={(e) => setId(e.target.value)} placeholder="contact" autoFocus />
            </label>
            <label className="field">
              <span>Name</span>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Contact form" />
            </label>
            <div className="row" style={{ gap: '0.5rem' }}>
              <button type="submit" className="btn btn-primary" disabled={busy}>Create</button>
              <button type="button" className="btn" onClick={() => { setCreating(false); setError(null); }}>Cancel</button>
            </div>
          </form>
        ) : (
          <button className="btn" onClick={() => setCreating(true)} style={{ alignSelf: 'flex-start' }}>
            <Plus size={16} aria-hidden /> New form
          </button>
        )
      )}
    </div>
  );
}
