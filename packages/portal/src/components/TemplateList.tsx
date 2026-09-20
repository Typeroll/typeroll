// Sidebar + main area for /app/sites/{id}/templates. Lists templates,
// lets the user create a new one (modal-free — name + label inline),
// and links to the editor at /app/sites/{id}/templates/{templateId}.

import { useEffect, useState } from 'react';
import type { PageTemplate } from '@typeroll/shared';
import { Plus, FileSymlink, Trash2 } from 'lucide-react';

export default function TemplateList({ siteId }: { siteId: string }) {
  const [templates, setTemplates] = useState<PageTemplate[]>([]);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [starter, setStarter] = useState('custom');
  const [error, setError] = useState<string | null>(null);

  async function refresh(): Promise<void> {
    const res = await fetch(`/api/sites/${siteId}/templates`);
    if (res.ok) {
      const body = await res.json() as { templates: PageTemplate[] };
      setTemplates(body.templates);
    }
  }

  useEffect(() => { void refresh(); }, [siteId]);

  async function create(): Promise<void> {
    setError(null);
    const name = newName.trim();
    if (!name) { setError('Name is required'); return; }
    const res = await fetch(`/api/sites/${siteId}/templates`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name,
        label: newLabel.trim() || name,
        applies_to: 'any',
        status: 'draft',
        starter,
      }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({})) as { error?: string };
      setError(j.error ?? `Create failed (${res.status})`);
      return;
    }
    const created = await res.json() as PageTemplate;
    window.location.href = `/app/sites/${siteId}/templates/${created.id}`;
  }

  async function remove(id: string): Promise<void> {
    if (!confirm(`Delete the template "${id}"? Choose another template for any pages or content types using it first.`)) return;
    const res = await fetch(`/api/sites/${siteId}/templates?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (res.ok) await refresh();
    else { const body = await res.json(); setError(body.error ?? "Could not delete template"); }
  }

  return (
    <div style={shell}>
      <header style={head}>
        <h1 style={{ margin: 0, fontSize: '1.1rem' }}>Templates</h1>
        <button type="button" onClick={() => setCreating(true)} style={primaryBtn}>
          <Plus size={14} /> New template
        </button>
      </header>

      <p style={muted}>
        A template is a block tree that wraps a page's content. It contains at
        least one block of type <code>template_content_slot</code>, which is
        replaced by the page's own blocks at render time.
      </p>

      {creating && (
        <div style={createCard}>
          <h3 style={{ marginTop: 0 }}>New template</h3>
          <label style={fieldLabel}>Template ID (for example, blog-post)
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              style={input}
              placeholder="blog_post"
              autoFocus
            />
          </label>
          <label style={fieldLabel}>Label
            <input
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              style={input}
              placeholder="Blog post"
            />
          </label>
          <label style={fieldLabel}>Starting layout
            <select style={input} value={starter} onChange={event => setStarter(event.target.value)}>
              {['custom', 'article', 'blog', 'checklist', 'team', 'events', 'products', 'profile', 'landing'].map(kind => <option key={kind} value={kind}>{kind === 'custom' ? 'Title and page content' : kind[0].toUpperCase() + kind.slice(1)}</option>)}
            </select>
          </label>
          {error && <p style={errorMsg}>{error}</p>}
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button type="button" onClick={create} style={primaryBtn}>Create</button>
            <button type="button" onClick={() => setCreating(false)} style={secondaryBtn}>Cancel</button>
          </div>
        </div>
      )}

      {templates.length === 0 && !creating && (
        <p style={muted}>No templates yet. Create one to get started.</p>
      )}

      {!creating && error && <p role="alert" style={errorMsg}>{error}</p>}
      <ul style={list}>
        {templates.map((t) => (
          <li key={t.id} style={row}>
            <FileSymlink size={16} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <a href={`/app/sites/${siteId}/templates/${t.id}`} style={rowTitle}>
                {t.label}
              </a>
              <div style={rowMeta}>
                {t.name} · {t.status} · {t.blocks.length} block
              </div>
            </div>
            <button type="button" onClick={() => remove(t.id)} style={iconBtn} title="Delete">
              <Trash2 size={14} />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

const shell: React.CSSProperties = {
  padding: '2rem', maxWidth: 720, margin: '0 auto', color: 'var(--color-text)',
};
const head: React.CSSProperties = {
  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
  marginBottom: '1rem', flexWrap: 'wrap', gap: '0.75rem',
};
const muted: React.CSSProperties = {
  color: 'var(--color-text-muted)', fontSize: '.9rem', margin: '0 0 1rem',
};
const createCard: React.CSSProperties = {
  background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 8,
  padding: '1rem', marginBottom: '1rem',
};
const fieldLabel: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 4, marginBottom: '.75rem',
  fontSize: '.75rem', color: 'var(--color-text-muted)',
};
const input: React.CSSProperties = {
  padding: '.4rem .6rem', background: 'var(--color-surface)', color: 'var(--color-text)',
  border: '1px solid var(--color-border)', borderRadius: 6, fontSize: '.9rem',
};
const list: React.CSSProperties = { listStyle: 'none', padding: 0, margin: 0 };
const row: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 12,
  padding: '.6rem .75rem', borderBottom: '1px solid var(--color-border)',
};
const rowTitle: React.CSSProperties = {
  color: 'var(--color-text)', textDecoration: 'none', fontWeight: 500, overflowWrap: 'anywhere',
};
const rowMeta: React.CSSProperties = { fontSize: '.75rem', color: 'var(--color-text-muted)', marginTop: 2 };
const primaryBtn: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 4,
  padding: '.4rem .8rem', background: 'var(--color-primary)', color: '#fff',
  border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: '.85rem',
};
const secondaryBtn: React.CSSProperties = {
  padding: '.4rem .8rem', background: 'transparent', color: 'var(--color-text)',
  border: '1px solid var(--color-border)', borderRadius: 6, cursor: 'pointer', fontSize: '.85rem',
};
const iconBtn: React.CSSProperties = {
  background: 'none', border: 'none', color: 'var(--color-text-muted)', cursor: 'pointer', padding: 4,
};
const errorMsg: React.CSSProperties = { color: 'var(--color-danger)', fontSize: '.85rem', margin: 0 };
