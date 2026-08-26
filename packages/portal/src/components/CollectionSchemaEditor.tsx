import { useState } from 'react';
import type { CollectionDef, FieldDefinition, FieldType } from '@typeroll/shared';

const FIELD_TYPES: FieldType[] = [
  'text', 'textarea', 'richtext', 'image', 'url', 'email', 'date', 'select', 'boolean', 'number',
];

interface Props {
  siteId: string;
  collection: CollectionDef;
}

export default function CollectionSchemaEditor({ siteId, collection }: Props) {
  const [fields, setFields] = useState<FieldDefinition[]>(collection.fields);
  const [schemaType, setSchemaType] = useState<string>(collection.schema_type ?? '');
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  function update(i: number, patch: Partial<FieldDefinition>) {
    setFields(fields.map((f, idx) => (idx === i ? { ...f, ...patch } : f)));
  }
  function addField() {
    setFields([
      ...fields,
      { name: `field_${fields.length + 1}`, label: 'New field', type: 'text' },
    ]);
  }
  function remove(i: number) {
    setFields(fields.filter((_, idx) => idx !== i));
  }
  function move(i: number, dir: -1 | 1) {
    const j = i + dir;
    if (j < 0 || j >= fields.length) return;
    const next = fields.slice();
    [next[i], next[j]] = [next[j], next[i]];
    setFields(next);
  }

  async function save() {
    setStatus('saving');
    setError(null);
    try {
      const res = await fetch(`/api/sites/${siteId}/collections/${collection.name}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields, schema_type: schemaType.trim() || undefined }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Failed');
      setStatus('saved');
      window.setTimeout(() => setStatus('idle'), 1200);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
      setStatus('error');
    }
  }

  async function destroy() {
    if (!confirm(`Delete the "${collection.label_plural}" collection? This removes all items too.`)) return;
    const res = await fetch(`/api/sites/${siteId}/collections/${collection.name}`, { method: 'DELETE' });
    if (res.ok) window.location.href = `/app/sites/${siteId}/collections`;
  }

  return (
    <div className="stack-sm">
      {fields.map((f, i) => (
        <div key={i} className="schema-row">
          <div className="schema-row__top">
            <div className="schema-row__handle">
              <button type="button" onClick={() => move(i, -1)} disabled={i === 0} aria-label="Move up">↑</button>
              <button type="button" onClick={() => move(i, 1)} disabled={i === fields.length - 1} aria-label="Move down">↓</button>
            </div>
            <input
              value={f.label}
              onChange={(e) => update(i, { label: e.target.value })}
              placeholder="Field label"
              className="schema-row__label"
            />
            <button type="button" onClick={() => remove(i)} className="btn btn--ghost btn--sm schema-row__remove" aria-label="Remove field">×</button>
          </div>
          <div className="schema-row__bottom">
            <input
              value={f.name}
              onChange={(e) => update(i, { name: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_') })}
              placeholder="machine_name"
              className="schema-row__name"
            />
            <select value={f.type} onChange={(e) => update(i, { type: e.target.value as FieldType })} className="schema-row__type">
              {FIELD_TYPES.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
            <label className="schema-row__required" title="Required">
              <input type="checkbox" checked={f.required ?? false} onChange={(e) => update(i, { required: e.target.checked })} />
              <span>Required</span>
            </label>
          </div>
        </div>
      ))}
      <button type="button" onClick={addField} className="btn btn--secondary btn--sm">+ Add field</button>

      <div className="field" style={{ marginTop: '1.25rem' }}>
        <label>Schema.org type (optional)</label>
        <input
          value={schemaType}
          onChange={(e) => setSchemaType(e.target.value)}
          placeholder='e.g. "BlogPosting", "PodcastEpisode", "Product"'
        />
        <p className="muted text-sm">When set, every item route emits JSON-LD with this @type. Built-in field mappings exist for BlogPosting, PodcastEpisode, Product, Event, Recipe, Course — anything else falls back to identity (field name = property name). Use the API to set <code>schema_field_map</code> for finer control.</p>
      </div>

      <div className="row" style={{ marginTop: '1rem', justifyContent: 'space-between' }}>
        <button type="button" onClick={save} className="btn">{status === 'saving' ? 'Saving…' : status === 'saved' ? 'Saved ✓' : 'Save schema'}</button>
        <button type="button" onClick={destroy} className="btn btn--ghost btn--sm">Delete collection</button>
      </div>
      {error && <div style={{ color: 'var(--color-danger)', fontSize: '0.875rem' }}>{error}</div>}

      <style>{`
        .schema-row {
          display: flex;
          flex-direction: column;
          gap: 0.375rem;
          padding: 0.625rem 0.75rem;
          border: 1px solid var(--color-border);
          border-radius: 0.5rem;
          background: var(--color-surface);
        }
        .schema-row + .schema-row { margin-top: 0.5rem; }
        .schema-row__top {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          min-width: 0;
        }
        .schema-row__bottom {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          flex-wrap: wrap;
          padding-left: calc(18px + 0.5rem); /* align under label, past the handle */
        }
        .schema-row input, .schema-row select {
          padding: 0.3rem 0.5rem;
          border: 1px solid var(--color-border);
          border-radius: 0.375rem;
          background: var(--color-surface);
          font-size: 0.875rem;
          min-width: 0;
        }
        .schema-row__label { flex: 1; min-width: 0; }
        .schema-row__name {
          flex: 1 1 110px;
          min-width: 90px;
          font-family: var(--font-mono);
          font-size: 0.8rem;
        }
        .schema-row__type {
          flex: 0 0 auto;
          width: auto;
        }
        .schema-row__required {
          display: inline-flex;
          align-items: center;
          gap: 0.35rem;
          font-size: 0.8rem;
          color: var(--color-text-muted);
          white-space: nowrap;
        }
        .schema-row__remove { flex-shrink: 0; }
        .schema-row__handle {
          display: flex; flex-direction: column; gap: 1px;
          flex-shrink: 0;
          width: 18px;
        }
        .schema-row__handle button {
          background: none; border: 0; cursor: pointer;
          color: var(--color-text-muted); font-size: 0.7rem;
          padding: 0;
          line-height: 1;
        }
        .schema-row__handle button:disabled { opacity: 0.3; cursor: default; }
      `}</style>
    </div>
  );
}
