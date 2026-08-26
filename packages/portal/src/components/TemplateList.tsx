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
        blocks: [],
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
    if (!confirm(`Delete the template "${id}"? Pages using it will keep rendering without a template.`)) return;
    const res = await fetch(`/api/sites/${siteId}/templates?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (res.ok) await refresh();
  }

  return (
    <div style={shell}>
      <header style={head}>
        <h1 style={{ margin: 0, fontSize: '1.1rem' }}>Templates</h1>
        <button type="button" onClick={() => setCreating(true)} style={primaryBtn}>
          <Plus size={14} /> Ny mall
        </button>
      </header>

      <p style={muted}>
        A template is a block tree that wraps a page's content. It contains at
        least one block of type <code>template_content_slot</code>, which is
        replaced by the page's own blocks at render time.
      </p>

      {creating && (
        <div style={createCard}>
          <h3 style={{ marginTop: 0 }}>Ny mall</h3>
          <label style={fieldLabel}>Namn (kebab/underscore, t.ex. blog_post)
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              style={input}
              placeholder="blog_post"
              autoFocus
            />
          </label>
          <label style={fieldLabel}>Etikett
            <input
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              style={input}
              placeholder="Blog post"
            />
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

      <ul style={list}>
        {templates.map((t) => (
          <li key={t.id} style={row}>
            <FileSymlink size={16} />
            <div style={{ flex: 1 }}>
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
  padding: '2rem', maxWidth: 720, margin: '0 auto', color: '#e4e4e7',
};
const head: React.CSSProperties = {
  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
  marginBottom: '1rem',
};
const muted: React.CSSProperties = {
  color: '#a1a1aa', fontSize: '.9rem', margin: '0 0 1rem',
};
const createCard: React.CSSProperties = {
  background: '#161618', border: '1px solid #2a2a30', borderRadius: 8,
  padding: '1rem', marginBottom: '1rem',
};
const fieldLabel: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 4, marginBottom: '.75rem',
  fontSize: '.75rem', color: '#a1a1aa',
};
const input: React.CSSProperties = {
  padding: '.4rem .6rem', background: '#1f1f23', color: '#fafafa',
  border: '1px solid #2a2a30', borderRadius: 6, fontSize: '.9rem',
};
const list: React.CSSProperties = { listStyle: 'none', padding: 0, margin: 0 };
const row: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 12,
  padding: '.6rem .75rem', borderBottom: '1px solid #1f1f23',
};
const rowTitle: React.CSSProperties = {
  color: '#fafafa', textDecoration: 'none', fontWeight: 500,
};
const rowMeta: React.CSSProperties = { fontSize: '.75rem', color: '#a1a1aa', marginTop: 2 };
const primaryBtn: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 4,
  padding: '.4rem .8rem', background: '#6366f1', color: '#fff',
  border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: '.85rem',
};
const secondaryBtn: React.CSSProperties = {
  padding: '.4rem .8rem', background: 'transparent', color: '#fafafa',
  border: '1px solid #2a2a30', borderRadius: 6, cursor: 'pointer', fontSize: '.85rem',
};
const iconBtn: React.CSSProperties = {
  background: 'none', border: 'none', color: '#a1a1aa', cursor: 'pointer', padding: 4,
};
const errorMsg: React.CSSProperties = { color: '#ef4444', fontSize: '.85rem', margin: 0 };
