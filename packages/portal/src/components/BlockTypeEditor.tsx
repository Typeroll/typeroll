// Editor for a single custom BlockType.
//
// Five sections:
//   1. Metadata — name, label, icon, category, container, item_compatible
//   2. Schema — field-definition list (name/type/label/required/options/
//      default/responsive)
//   3. Template — HTML markup with {{field}} / {{=tag}} / {{children}} /
//      {{slot:NAME}} / {{page.*}} / {{site.*}} placeholders. Warnings
//      surface for tokens that don't match the schema.
//   4. Styles — block-scoped CSS. Warning if any selector escapes the
//      block's `[data-block="…"]` scope.
//   5. Script — client-side JS, GATED behind an explicit consent toggle.
//
// The script section can only be edited after the user clicks "Aktivera JS"
// and confirms the warning. Scripts run with full DOM access on every
// visitor's browser — the user is taking on that responsibility.

import { useEffect, useMemo, useState } from 'react';
import type { BlockType, FieldDefinition, FieldType } from '@typeroll/shared';
import { Trash2, Plus, AlertTriangle, Save } from 'lucide-react';
import BlockTypePreview from './BlockTypePreview';

interface Props {
  siteId: string;
  blockType: BlockType | null; // null = create new
  onSaved: (bt: BlockType) => void;
  onDeleted?: (id: string) => void;
}

const CATEGORIES = ['layout', 'content', 'media', 'custom'] as const;
const FIELD_TYPES: FieldType[] = [
  'text', 'textarea', 'richtext', 'image', 'file', 'color',
  'select', 'boolean', 'number', 'url', 'email', 'date', 'datetime',
  'list', 'list_simple',
  // Phase 5 additions — the editor handler for these falls back to text
  // input for now; the new types are recognised so the schema can declare
  // them and the renderer / future editor improvements honour them.
  'icon', 'array', 'object', 'block_type_ref', 'collection_ref',
];

export default function BlockTypeEditor({ siteId, blockType, onSaved, onDeleted }: Props) {
  const isNew = !blockType;
  const [draft, setDraft] = useState<Partial<BlockType>>(() =>
    blockType ?? {
      name: '', label: '', icon: '', category: 'custom', container: false,
      schema: [], template: '', styles: '', script: '',
    },
  );
  const [jsEnabled, setJsEnabled] = useState(!!blockType?.script);
  const [showJsWarning, setShowJsWarning] = useState(false);
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (blockType) {
      setDraft(blockType);
      setJsEnabled(!!blockType.script);
    }
  }, [blockType?.id]);

  function set<K extends keyof BlockType>(k: K, v: BlockType[K] | undefined) {
    setDraft((d) => ({ ...d, [k]: v }));
  }

  function addField() {
    const schema = (draft.schema ?? []).slice();
    schema.push({ name: 'field_' + (schema.length + 1), type: 'text', label: 'New field' });
    set('schema', schema);
  }

  function updateField(idx: number, patch: Partial<FieldDefinition>) {
    const schema = (draft.schema ?? []).slice();
    schema[idx] = { ...schema[idx], ...patch };
    set('schema', schema);
  }

  function removeField(idx: number) {
    const schema = (draft.schema ?? []).slice();
    schema.splice(idx, 1);
    set('schema', schema);
  }

  async function save() {
    setStatus('saving');
    setError(null);
    const url = isNew
      ? `/api/sites/${siteId}/blocks/types`
      : `/api/sites/${siteId}/blocks/types?id=${encodeURIComponent(blockType!.id)}`;
    const method = isNew ? 'POST' : 'PATCH';
    try {
      const res = await fetch(url, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...draft, script: jsEnabled ? draft.script : '' }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(j.error ?? `${method} failed (${res.status})`);
      }
      const saved = await res.json() as BlockType;
      setStatus('saved');
      onSaved(saved);
      window.setTimeout(() => setStatus('idle'), 1200);
    } catch (e) {
      setError((e as Error).message);
      setStatus('error');
    }
  }

  async function del() {
    if (!blockType) return;
    if (!confirm(`Delete the block type "${blockType.label}"? Pages using it must be updated manually.`)) return;
    const res = await fetch(`/api/sites/${siteId}/blocks/types?id=${encodeURIComponent(blockType.id)}`, {
      method: 'DELETE',
    });
    if (res.ok) onDeleted?.(blockType.id);
  }

  return (
    <div style={shell}>
      <header style={header}>
        <div>
          <h2 style={{ margin: 0, fontSize: '1.05rem' }}>
            {isNew ? 'Ny blocktyp' : blockType!.label}
          </h2>
          <p style={{ margin: '2px 0 0', fontSize: '.75rem', opacity: 0.6 }}>
            {isNew ? 'Create a reusable block for this site.' : `id: ${blockType!.id}`}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {status === 'saving' && <span style={muted}>Saving…</span>}
          {status === 'saved' && <span style={{ color: '#22c55e', fontSize: '.85rem' }}>Saved</span>}
          {status === 'error' && <span style={{ color: '#ef4444', fontSize: '.85rem' }}>{error}</span>}
          {!isNew && (
            <button type="button" onClick={del} style={dangerBtn} title="Delete">
              <Trash2 size={14} /> Delete
            </button>
          )}
          <button type="button" onClick={save} style={primaryBtn}>
            <Save size={14} /> Save
          </button>
        </div>
      </header>

      <section style={section}>
        <h3 style={sectionH}>Metadata</h3>
        <div style={fieldGrid}>
          <Labeled label="Namn (id-suffix, kebab/underscore)">
            <input
              value={(draft.name as string) ?? ''}
              onChange={(e) => set('name', e.target.value as BlockType['name'])}
              style={input}
              placeholder="fancy_card"
            />
          </Labeled>
          <Labeled label="Etikett (visas i biblioteket)">
            <input
              value={(draft.label as string) ?? ''}
              onChange={(e) => set('label', e.target.value as BlockType['label'])}
              style={input}
              placeholder="Fancy Card"
            />
          </Labeled>
          <Labeled label="Kategori">
            <select
              value={(draft.category as string) ?? 'custom'}
              onChange={(e) => set('category', e.target.value as BlockType['category'])}
              style={input}
            >
              {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </Labeled>
          <Labeled label="Container">
            <select
              value={
                draft.container === true ? 'true'
                : draft.container === 'slots' ? 'slots'
                : draft.container === 'repeater' ? 'repeater'
                : draft.container === 'conditional' ? 'conditional'
                : 'false'
              }
              onChange={(e) => {
                const v = e.target.value;
                let val: BlockType['container'];
                if (v === 'true') val = true;
                else if (v === 'slots') val = 'slots';
                else if (v === 'repeater') val = 'repeater';
                else if (v === 'conditional') val = 'conditional';
                else val = false;
                set('container', val);
              }}
              style={input}
            >
              <option value="false">Inget (kan inte ha barn)</option>
              <option value="true">Ja (en lista av barn)</option>
              <option value="slots">Slot-baserad (flera namngivna slots)</option>
              <option value="repeater">Repeater (loopar items[])</option>
              <option value="conditional">Conditional (visas vid villkor)</option>
            </select>
          </Labeled>
          {draft.container === 'slots' && (
            <>
              <Labeled label="Antal slots (1-8)">
                <input
                  type="number"
                  min={1} max={8}
                  value={draft.slot_count ?? 2}
                  onChange={(e) => set('slot_count', Number(e.target.value))}
                  style={input}
                />
              </Labeled>
              <Labeled label="Slot-etiketter (komma-separerat)">
                <input
                  value={(draft.slot_labels ?? []).join(', ')}
                  onChange={(e) => set('slot_labels', e.target.value.split(',').map((s) => s.trim()).filter(Boolean))}
                  style={input}
                  placeholder="Left, Right"
                />
              </Labeled>
            </>
          )}
          <Labeled label="Usable as a repeater item">
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '.85rem' }}>
              <input
                type="checkbox"
                checked={!!draft.item_compatible}
                onChange={(e) => set('item_compatible', e.target.checked || undefined)}
              />
              <span style={muted}>Offered as an option in the repeater item picker</span>
            </label>
          </Labeled>
        </div>
      </section>

      <section style={section}>
        <h3 style={sectionH}>
          Fields
          <button type="button" onClick={addField} style={smallBtn}>
            <Plus size={12} /> Add
          </button>
        </h3>
        {(draft.schema ?? []).length === 0 && (
          <p style={muted}>No fields yet. Add the fields an editor should fill in.</p>
        )}
        {(draft.schema ?? []).map((f, i) => (
          <div key={i} style={fieldRow}>
            <input
              value={f.name}
              onChange={(e) => updateField(i, { name: e.target.value })}
              style={{ ...input, flex: '0 0 140px' }}
              placeholder="field_name"
            />
            <select
              value={f.type}
              onChange={(e) => updateField(i, { type: e.target.value as FieldType })}
              style={{ ...input, flex: '0 0 130px' }}
            >
              {FIELD_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            <input
              value={f.label}
              onChange={(e) => updateField(i, { label: e.target.value })}
              style={{ ...input, flex: 1 }}
              placeholder="Label"
            />
            <label style={checkboxLabel}>
              <input
                type="checkbox"
                checked={!!f.required}
                onChange={(e) => updateField(i, { required: e.target.checked })}
              /> required
            </label>
            <label style={checkboxLabel} title="Allow per-breakpoint values in the editor">
              <input
                type="checkbox"
                checked={!!f.responsive}
                onChange={(e) => updateField(i, { responsive: e.target.checked || undefined })}
              /> responsive
            </label>
            <button type="button" onClick={() => removeField(i)} style={iconBtn} title="Delete">
              <Trash2 size={12} />
            </button>
          </div>
        ))}
      </section>

      <BlockTypePreview draft={draft} />

      <section style={section}>
        <h3 style={sectionH}>Template (HTML)</h3>
        <p style={muted}>
          Use <code>{'{{field_name}}'}</code> for HTML-escaped values,
          <code>{' {{{field_name}}} '}</code> for raw HTML (richtext),
          <code> {'{{=field}}'} </code> for tag names (h1..h6 etc.),
          <code> {'{{children}}'} </code> for container children,
          <code> {'{{slot:NAME}}'} </code> for slot content.
          In template context (PageTemplate) also <code>{'{{page.title}}'}</code>,
          <code>{' {{site.logo}}'}</code>, <code>{' {{item.field}}'}</code>.
        </p>
        <TemplateWarnings template={draft.template ?? ''} schema={draft.schema ?? []} />
        <textarea
          rows={10}
          value={draft.template ?? ''}
          onChange={(e) => set('template', e.target.value)}
          style={{ ...input, fontFamily: 'ui-monospace, monospace' }}
          placeholder={'<section data-block="' + (draft.name || 'fancy') + '"><h2>{{title}}</h2>{{{body}}}</section>'}
        />
      </section>

      <section style={section}>
        <h3 style={sectionH}>CSS</h3>
        <p style={muted}>
          Block-scoped CSS. Selectors should start with <code>[data-block="{draft.name || 'name'}"]</code> so they
          don't leak into the rest of the site. Concatenated into the site bundle at deploy.
        </p>
        <CssScopeWarnings styles={draft.styles ?? ''} blockName={draft.name ?? ''} />
        <textarea
          rows={8}
          value={draft.styles ?? ''}
          onChange={(e) => set('styles', e.target.value)}
          style={{ ...input, fontFamily: 'ui-monospace, monospace' }}
          placeholder={'[data-block="' + (draft.name || 'fancy') + '"]{padding:1rem}'}
        />
      </section>

      <section style={section}>
        <h3 style={sectionH}>JavaScript (avancerat)</h3>
        {!jsEnabled && (
          <div style={warningBox}>
            <AlertTriangle size={16} />
            <div>
              <strong>Client code runs in the visitor’s browser with full DOM access.</strong>
              <p style={{ margin: '4px 0 0', fontSize: '.85rem' }}>
                You take full responsibility for security and performance. Other users in the same org
                who visit the site will execute this code. The script is not sanitised.
              </p>
              <button
                type="button"
                onClick={() => { setShowJsWarning(true); setTimeout(() => { setJsEnabled(true); setShowJsWarning(false); }, 100); }}
                style={{ ...primaryBtn, marginTop: 8 }}
              >
                I understand — enable JS editing
              </button>
            </div>
          </div>
        )}
        {jsEnabled && (
          <>
            <p style={muted}>
              Call <code>window.TyperollBlocks.register(id, init)</code> where <code>init(el, data)</code>
              is called for every instance of the block on page load.
            </p>
            <textarea
              rows={8}
              value={draft.script ?? ''}
              onChange={(e) => set('script', e.target.value)}
              style={{ ...input, fontFamily: 'ui-monospace, monospace' }}
              placeholder={`window.TyperollBlocks.register('user/${draft.name ?? 'block'}', function(el, data) {\n  // ...\n});`}
            />
          </>
        )}
      </section>

      {showJsWarning && null}
    </div>
  );
}

function Labeled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: '.75rem', opacity: 0.7 }}>{label}</span>
      {children}
    </label>
  );
}

/**
 * Surfaces template-token issues in real time. Catches:
 *   - {{field}} where field isn't in the schema (typo or removed field)
 *   - {{children}} used without `container: true`
 *   - {{slot:N}} used without `container: 'slots'`
 *   - {{=field}} pointing at a field whose values aren't valid HTML tags
 * Context namespaces (`page.*`, `site.*`, `item.*`) pass through —
 * those are template-time bindings, not block schema fields.
 */
const CONTEXT_NAMESPACES = new Set(['page', 'site', 'item', 'collection']);

function TemplateWarnings({
  template,
  schema,
}: {
  template: string;
  schema: FieldDefinition[];
}) {
  const warnings = useMemo(() => {
    const out: string[] = [];
    const names = new Set(schema.map((f) => f.name));
    const tokens = [...template.matchAll(/\{\{\{?\s*=?\s*([\w.:-]+)\s*\}?\}\}/g)];
    for (const m of tokens) {
      const tok = m[1]!;
      if (tok === 'children') continue;
      if (tok.startsWith('slot:')) continue;
      // Dotted: first segment must be a known namespace
      if (tok.includes('.')) {
        const head = tok.split('.')[0]!;
        if (!CONTEXT_NAMESPACES.has(head) && !names.has(head)) {
          out.push(`Unknown namespace or field: "${tok}". Use {{page.*}}, {{site.*}}, {{item.*}} or a schema field.`);
        }
        continue;
      }
      if (!names.has(tok)) {
        out.push(`Token {{${tok}}} matches no schema field.`);
      }
    }
    return out;
  }, [template, schema]);

  if (warnings.length === 0) return null;
  return (
    <div style={inlineWarn}>
      <AlertTriangle size={14} />
      <ul style={{ margin: 0, paddingLeft: 18 }}>
        {warnings.map((w, i) => <li key={i}>{w}</li>)}
      </ul>
    </div>
  );
}

/**
 * Warn when CSS selectors don't open with `[data-block="{name}"]`. A
 * loose selector like `h1 { … }` would leak across the whole site once
 * the block bundle is concatenated. This is a soft check (warning only,
 * not a save-blocker) because @keyframes / @media / utility-style
 * fragments are legitimately unscoped.
 */
function CssScopeWarnings({
  styles,
  blockName,
}: {
  styles: string;
  blockName: string;
}) {
  const warnings = useMemo(() => {
    if (!styles.trim()) return [];
    const out: string[] = [];
    // Strip @-rules to inspect inner selectors
    const stripped = styles
      .replace(/@media[^{]+\{[\s\S]*?\}\s*\}/g, '')
      .replace(/@keyframes[^{]+\{[\s\S]*?\}\s*\}/g, '')
      .replace(/@supports[^{]+\{[\s\S]*?\}\s*\}/g, '');
    const ruleBlocks = stripped.split('}').map((b) => b.split('{')[0]?.trim() ?? '').filter(Boolean);
    const scopePrefix = `[data-block="${blockName}"`;
    for (const sel of ruleBlocks) {
      if (!sel || sel.startsWith('/*') || sel.startsWith('@')) continue;
      // Allow multi-selector lists if every comma-separated part is scoped
      const parts = sel.split(',').map((s) => s.trim()).filter(Boolean);
      for (const p of parts) {
        if (!p.includes(scopePrefix) && !p.includes('[data-block="')) {
          out.push(`Unscoped selector: "${p}". Prefix it with ${scopePrefix}"].`);
        }
      }
      if (out.length > 5) break;
    }
    return out;
  }, [styles, blockName]);

  if (warnings.length === 0) return null;
  return (
    <div style={inlineWarn}>
      <AlertTriangle size={14} />
      <ul style={{ margin: 0, paddingLeft: 18 }}>
        {warnings.slice(0, 5).map((w, i) => <li key={i}>{w}</li>)}
        {warnings.length > 5 && <li>…och {warnings.length - 5} till.</li>}
      </ul>
    </div>
  );
}

const shell: React.CSSProperties = {
  padding: '1.5rem', color: '#e4e4e7', maxWidth: 920, margin: '0 auto',
};
const header: React.CSSProperties = {
  display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
  marginBottom: '1.5rem', gap: '1rem',
};
const section: React.CSSProperties = {
  marginBottom: '1.5rem', padding: '1rem',
  border: '1px solid #2a2a30', borderRadius: 8, background: '#161618',
};
const sectionH: React.CSSProperties = {
  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
  margin: '0 0 .75rem', fontSize: '.95rem',
};
const fieldGrid: React.CSSProperties = {
  display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem',
};
const fieldRow: React.CSSProperties = {
  display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6,
};
const input: React.CSSProperties = {
  padding: '.4rem .6rem', background: '#1f1f23', color: '#fafafa',
  border: '1px solid #2a2a30', borderRadius: 6, fontSize: '.85rem',
  boxSizing: 'border-box', width: '100%',
};
const muted: React.CSSProperties = { color: '#a1a1aa', fontSize: '.85rem', margin: '0 0 .5rem' };
const primaryBtn: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 4,
  padding: '.4rem .8rem', background: '#6366f1', color: '#fff',
  border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: '.85rem',
};
const smallBtn: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 4,
  padding: '.2rem .5rem', background: '#1f1f23', color: '#fafafa',
  border: '1px solid #2a2a30', borderRadius: 6, cursor: 'pointer', fontSize: '.75rem',
};
const dangerBtn: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 4,
  padding: '.4rem .8rem', background: 'transparent', color: '#ef4444',
  border: '1px solid #ef4444', borderRadius: 6, cursor: 'pointer', fontSize: '.85rem',
};
const iconBtn: React.CSSProperties = {
  background: 'none', border: 'none', color: '#a1a1aa', cursor: 'pointer', padding: 4,
};
const checkboxLabel: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 4, fontSize: '.75rem', color: '#a1a1aa',
};
const warningBox: React.CSSProperties = {
  display: 'flex', gap: 12, padding: '1rem',
  background: '#3b2410', color: '#fbbf24',
  border: '1px solid #92400e', borderRadius: 6,
};
const inlineWarn: React.CSSProperties = {
  display: 'flex', gap: 8, alignItems: 'flex-start', padding: '.5rem .75rem',
  background: '#3b2410', color: '#fbbf24',
  border: '1px solid #92400e', borderRadius: 6,
  fontSize: '.8rem', marginBottom: 8,
};
