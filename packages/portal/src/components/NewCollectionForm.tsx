import { useState } from 'react';
import { getCollectionStarter, type CollectionStarterKind } from '@typeroll/shared';

interface Template {
  name: string;
  label_plural: string;
  label_singular: string;
  icon: string;
  description: string;
  fields: { name: string; label: string; type: string; required?: boolean }[];
  slug_field?: string;
  sort_field?: string;
}

const TEMPLATES: Template[] = [
  {
    name: 'blog',
    label_singular: 'Blog post',
    label_plural: 'Blog posts',
    icon: '✍️',
    description: 'Long-form articles, dated and authored.',
    slug_field: 'slug',
    sort_field: 'published_at',
    fields: [
      { name: 'title', label: 'Title', type: 'text', required: true },
      { name: 'slug', label: 'Slug', type: 'text', required: true },
      { name: 'excerpt', label: 'Excerpt', type: 'textarea' },
      { name: 'body', label: 'Body (HTML)', type: 'richtext', required: true },
      { name: 'featured_image', label: 'Featured image', type: 'image' },
      { name: 'author', label: 'Author', type: 'text' },
      { name: 'published_at', label: 'Published at', type: 'date' },
    ],
  },
  {
    name: 'team',
    label_singular: 'Team member',
    label_plural: 'Team members',
    icon: '👥',
    description: 'People on your team — name, role, photo, bio.',
    sort_field: 'sort_order',
    fields: [
      { name: 'name', label: 'Name', type: 'text', required: true },
      { name: 'role', label: 'Role', type: 'text' },
      { name: 'bio', label: 'Bio', type: 'textarea' },
      { name: 'photo', label: 'Photo', type: 'image' },
      { name: 'email', label: 'Email', type: 'email' },
      { name: 'linkedin', label: 'LinkedIn URL', type: 'url' },
      { name: 'sort_order', label: 'Sort order', type: 'number' },
    ],
  },
  {
    name: 'events',
    label_singular: 'Event',
    label_plural: 'Events',
    icon: '📅',
    description: 'Upcoming events with dates and locations.',
    sort_field: 'start_at',
    fields: [
      { name: 'name', label: 'Event name', type: 'text', required: true },
      { name: 'slug', label: 'Slug', type: 'text' },
      { name: 'description', label: 'Description', type: 'textarea' },
      { name: 'start_at', label: 'Starts at', type: 'date', required: true },
      { name: 'end_at', label: 'Ends at', type: 'date' },
      { name: 'location', label: 'Location', type: 'text' },
      { name: 'image', label: 'Image', type: 'image' },
      { name: 'rsvp_url', label: 'RSVP URL', type: 'url' },
    ],
  },
  {
    name: 'products',
    label_singular: 'Product',
    label_plural: 'Products',
    icon: '🛒',
    description: 'Product listings (informational — checkout uses an external system).',
    fields: [
      { name: 'name', label: 'Name', type: 'text', required: true },
      { name: 'slug', label: 'Slug', type: 'text' },
      { name: 'description', label: 'Description', type: 'richtext' },
      { name: 'price', label: 'Price', type: 'number' },
      { name: 'image', label: 'Image', type: 'image' },
      { name: 'buy_url', label: 'Buy URL', type: 'url' },
      { name: 'in_stock', label: 'In stock', type: 'boolean' },
    ],
  },
  {
    name: 'custom',
    label_singular: 'Item',
    label_plural: 'Items',
    icon: '📋',
    description: 'Start blank — define your own fields.',
    fields: [{ name: 'title', label: 'Title', type: 'text', required: true }],
  },
];

interface Props {
  siteId: string;
}

export default function NewCollectionForm({ siteId }: Props) {
  const [picked, setPicked] = useState<Template>(TEMPLATES[0]);
  const [name, setName] = useState(picked.name);
  const [labelSingular, setLabelSingular] = useState(picked.label_singular);
  const [labelPlural, setLabelPlural] = useState(picked.label_plural);
  const [icon, setIcon] = useState(picked.icon);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function pickTemplate(t: Template) {
    setPicked(t);
    setName(t.name === 'custom' ? '' : t.name);
    setLabelSingular(t.label_singular);
    setLabelPlural(t.label_plural);
    setIcon(t.icon);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/sites/${siteId}/collections`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          label_singular: labelSingular,
          label_plural: labelPlural,
          icon,
          fields: picked.fields,
          slug_field: picked.slug_field,
          sort_field: picked.sort_field,
          // Drives the starter item_template_blocks tree the API picks.
          // Maps directly to CollectionStarterKind in shared/collection-starters.ts.
          template_kind: picked.name,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Failed');
      window.location.href = `/app/sites/${siteId}/collections/${data.name}`;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="stack" style={{ maxWidth: 800 }}>
      <div className="card stack">
        <h2 style={{ fontSize: '1rem' }}>Start from a template</h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: '0.75rem' }}>
          {TEMPLATES.map((t) => (
            <button
              type="button"
              key={t.name}
              onClick={() => pickTemplate(t)}
              className="template-tile"
              data-active={picked.name === t.name}
            >
              <div style={{ fontSize: '1.5rem' }}>{t.icon}</div>
              <div style={{ fontWeight: 600, marginTop: '0.25rem' }}>{t.label_plural}</div>
              <div className="muted text-sm" style={{ marginTop: '0.25rem' }}>{t.description}</div>
            </button>
          ))}
        </div>
      </div>

      <div className="card stack">
        <h2 style={{ fontSize: '1rem' }}>Collection details</h2>
        <div className="field">
          <label>Machine name (used in URLs and the API)</label>
          <input value={name} onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_'))} required pattern="[a-z][a-z0-9_]*" placeholder="blog" />
        </div>
        <div className="field">
          <label>Singular label</label>
          <input value={labelSingular} onChange={(e) => setLabelSingular(e.target.value)} required />
        </div>
        <div className="field">
          <label>Plural label</label>
          <input value={labelPlural} onChange={(e) => setLabelPlural(e.target.value)} required />
        </div>
        <div className="field">
          <label>Icon (emoji)</label>
          <input value={icon} onChange={(e) => setIcon(e.target.value)} maxLength={4} style={{ width: 80 }} />
        </div>
      </div>

      <div className="card stack">
        <h2 style={{ fontSize: '1rem' }}>Fields ({picked.fields.length})</h2>
        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {picked.fields.map((f) => (
            <li key={f.name} style={{ display: 'flex', gap: '0.75rem', padding: '0.4rem 0', borderBottom: '1px solid var(--color-border)' }}>
              <span style={{ flex: 1 }}><strong>{f.label}</strong> <span className="muted text-sm">({f.name})</span></span>
              <span className="muted text-sm">{f.type}{f.required ? ' · required' : ''}</span>
            </li>
          ))}
        </ul>
        <p className="muted text-sm">You can add or remove fields after the collection is created.</p>
      </div>

      <ItemTemplateStarter kind={picked.name} />


      {error && <div style={{ color: 'var(--color-danger)', fontSize: '0.875rem' }}>{error}</div>}
      <div className="row">
        <button type="submit" disabled={busy} className="btn">{busy ? 'Creating…' : `Create ${labelPlural}`}</button>
      </div>

      <style>{`
        .template-tile {
          padding: 1rem;
          border: 1px solid var(--color-border);
          background: var(--color-surface);
          border-radius: 0.5rem;
          text-align: left;
          cursor: pointer;
        }
        .template-tile[data-active="true"] {
          border-color: var(--color-primary);
          box-shadow: 0 0 0 3px rgba(15,23,42,0.06);
        }
      `}</style>
    </form>
  );
}

/**
 * Shows the user which item-template block tree will be installed when
 * they create the collection. Surfaces transparency — the AI got
 * something for free, we should show the user what they're getting too,
 * so they can adjust it from the collection's Templates tab afterwards.
 */
function ItemTemplateStarter({ kind }: { kind: string }) {
  const starter = getCollectionStarter(kind as CollectionStarterKind);
  if (!starter || starter.length === 0) return null;
  return (
    <div className="card stack">
      <h2 style={{ fontSize: '1rem' }}>
        Item layout
        <span className="muted text-sm" style={{ marginLeft: '0.5rem', fontWeight: 400 }}>
          (block-mode, editable after creation)
        </span>
      </h2>
      <p className="muted text-sm" style={{ margin: 0 }}>
        Each item renders with this block tree. The renderer pushes the
        item's field values into context so <code>{`{{item.title}}`}</code>,
        <code>{` {{item.body}}`}</code> etc. resolve per item.
      </p>
      <ol style={{ margin: 0, paddingLeft: '1.25rem', fontSize: '0.875rem' }}>
        {starter.map((b) => (
          <li key={b.id} style={{ padding: '0.15rem 0' }}>
            <code>{b.type}</code>
            {Object.entries(b.data as Record<string, unknown>).length > 0 && (
              <span className="muted text-sm" style={{ marginLeft: '0.5rem' }}>
                ({Object.entries(b.data as Record<string, unknown>)
                  .map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ')})
              </span>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}
