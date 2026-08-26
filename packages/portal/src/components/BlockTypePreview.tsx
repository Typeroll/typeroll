// Live preview pane for the BlockTypeEditor.
//
// Renders the draft BlockType into an iframe with sample data derived from
// the schema. The iframe isolates the block's CSS from the editor chrome
// and gives us a clean canvas to test the block's actual visual output —
// including responsive @media rules at different widths.
//
// The preview re-renders synchronously on every draft change (the shared
// renderer is fast — a single block + its registry resolves in <1ms).
// Sample data is regenerated whenever the schema changes; the user can
// edit sample values in the "Test data" panel below the preview.

import { useEffect, useMemo, useState } from 'react';
import { Smartphone, Tablet, Monitor, Maximize2 } from 'lucide-react';
import {
  BLOCKS_RUNTIME_CSS,
  buildCoreBlockRegistry,
  collectBlockAssets,
  renderBlock,
  type Block,
  type BlockType,
  type FieldDefinition,
} from '@typeroll/shared';

interface Props {
  draft: Partial<BlockType>;
  /** Other custom block types on the site — needed when this block has expand_to or repeater item_block referencing them. */
  customTypes?: BlockType[];
}

type Width = 'mobile' | 'tablet' | 'laptop' | 'full';

const WIDTH_PX: Record<Width, string> = {
  mobile: '375px',
  tablet: '768px',
  laptop: '1024px',
  full: '100%',
};

export default function BlockTypePreview({ draft, customTypes = [] }: Props) {
  const [width, setWidth] = useState<Width>('full');
  const [sampleData, setSampleData] = useState<Record<string, unknown>>({});
  const [overridesOpen, setOverridesOpen] = useState(false);

  // Regenerate sample data when the schema changes (but preserve user
  // overrides where the field still exists).
  const schemaSignature = useMemo(
    () => JSON.stringify((draft.schema ?? []).map((f) => [f.name, f.type])),
    [draft.schema],
  );
  useEffect(() => {
    const fresh = defaultSampleData(draft.schema ?? []);
    setSampleData((prev) => {
      // Preserve overrides for fields that still exist with the same type.
      const out: Record<string, unknown> = {};
      for (const f of draft.schema ?? []) {
        if (f.name in prev) {
          out[f.name] = prev[f.name];
        } else {
          out[f.name] = fresh[f.name];
        }
      }
      return out;
    });
  }, [schemaSignature]);

  // Build the registry + complete BlockType + sample Block instance.
  // The renderer needs the block type registered to resolve its template.
  const html = useMemo(() => {
    try {
      return renderPreview(draft, sampleData, customTypes);
    } catch (e) {
      return `<pre style="color:#ef4444;padding:1rem;font-family:ui-monospace,monospace">${escapeForPre((e as Error).message)}</pre>`;
    }
  }, [draft, sampleData, customTypes]);

  return (
    <section style={section}>
      <h3 style={sectionH}>
        Preview
        <div style={widthToolbar}>
          <WidthBtn icon={<Smartphone size={14} />} label="Mobile (375)" active={width === 'mobile'} onClick={() => setWidth('mobile')} />
          <WidthBtn icon={<Tablet size={14} />}     label="Tablet (768)" active={width === 'tablet'} onClick={() => setWidth('tablet')} />
          <WidthBtn icon={<Monitor size={14} />}    label="Laptop (1024)" active={width === 'laptop'} onClick={() => setWidth('laptop')} />
          <WidthBtn icon={<Maximize2 size={14} />}  label="Full" active={width === 'full'} onClick={() => setWidth('full')} />
        </div>
      </h3>
      <div style={previewFrame}>
        <iframe
          title="Block preview"
          srcDoc={html}
          style={{ ...iframeStyle, width: WIDTH_PX[width], maxWidth: '100%' }}
          sandbox="allow-same-origin"
        />
      </div>

      <button
        type="button"
        onClick={() => setOverridesOpen((o) => !o)}
        style={overridesToggle}
      >
        {overridesOpen ? '▾' : '▸'} Sample data ({Object.keys(sampleData).length} fields)
      </button>
      {overridesOpen && (
        <div style={overridesPanel}>
          {(draft.schema ?? []).length === 0 && (
            <p style={muted}>No schema fields defined — sample data appears once you add fields.</p>
          )}
          {(draft.schema ?? []).map((f) => (
            <SampleField
              key={f.name}
              field={f}
              value={sampleData[f.name]}
              onChange={(v) => setSampleData((d) => ({ ...d, [f.name]: v }))}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function WidthBtn({ icon, label, active, onClick }: { icon: React.ReactNode; label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      title={label}
      onClick={onClick}
      style={{ ...widthBtn, ...(active ? widthBtnActive : {}) }}
    >
      {icon}
    </button>
  );
}

function SampleField({
  field, value, onChange,
}: {
  field: FieldDefinition;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  // Tiny inline editor — not the full schema-aware form, just enough to
  // tweak preview values quickly. Falls back to a text input for types
  // we don't have a specialised UI for.
  if (field.type === 'boolean') {
    return (
      <label style={overrideRow}>
        <span style={overrideLabel}>{field.label}</span>
        <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} />
      </label>
    );
  }
  if (field.type === 'select' && field.options) {
    return (
      <label style={overrideRow}>
        <span style={overrideLabel}>{field.label}</span>
        <select value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} style={overrideInput}>
          {field.options.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
        </select>
      </label>
    );
  }
  if (field.type === 'richtext' || field.type === 'textarea') {
    return (
      <label style={overrideRow}>
        <span style={overrideLabel}>{field.label}</span>
        <textarea
          value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value)}
          style={{ ...overrideInput, fontFamily: 'ui-monospace, monospace', minHeight: 56 }}
        />
      </label>
    );
  }
  return (
    <label style={overrideRow}>
      <span style={overrideLabel}>{field.label}</span>
      <input
        type={field.type === 'number' ? 'number' : 'text'}
        value={value == null ? '' : String(value)}
        onChange={(e) => onChange(field.type === 'number' ? Number(e.target.value) : e.target.value)}
        style={overrideInput}
      />
    </label>
  );
}

/**
 * Build an HTML document for the preview iframe.
 *   1. Construct a one-block tree from the draft + sample data.
 *   2. Render via @typeroll/shared's renderBlock.
 *   3. Wrap in a tiny shell with the block's styles + base typography.
 */
export function renderPreview(
  draft: Partial<BlockType>,
  data: Record<string, unknown>,
  customTypes: BlockType[] = [],
): string {
  if (!draft.template) {
    return `<div style="padding:2rem;font-family:system-ui;color:#666;text-align:center">
      No template yet — start writing HTML in the Template field and the result appears here.
    </div>`;
  }
  // Synthesise a complete BlockType. Missing required fields get sane
  // fallbacks so the registry doesn't reject the draft on the way in.
  const id = draft.name ? `preview/${draft.name}` : 'preview/draft';
  const completeType: BlockType = {
    id,
    name: draft.name ?? 'preview',
    label: draft.label ?? 'Preview',
    category: draft.category ?? 'custom',
    container: draft.container ?? false,
    slot_count: draft.slot_count,
    slot_labels: draft.slot_labels,
    item_compatible: draft.item_compatible,
    expand_to: draft.expand_to,
    schema: draft.schema ?? [],
    template: draft.template,
    styles: draft.styles,
    origin: draft.origin ?? 'user',
    created_at: draft.created_at ?? new Date().toISOString(),
  };

  // Merge the core registry with the user's custom types and our preview type.
  const registry = buildCoreBlockRegistry();
  for (const bt of customTypes) registry.set(bt.id, bt);
  registry.set(id, completeType);

  // For container blocks, give a visible placeholder so the slot/children
  // area isn't empty.
  const previewChildren: Block[] | undefined =
    completeType.container === true || completeType.container === 'slots'
      ? [{
          id: 'preview-child',
          type: 'core/prose',
          data: { html: '<p style="opacity:0.6;font-style:italic">Children appear here.</p>' },
        }]
      : undefined;
  const previewSlots: Block[][] | undefined =
    completeType.container === 'slots'
      ? Array.from({ length: completeType.slot_count ?? 2 }, (_, i) => [{
          id: `preview-slot-${i}`,
          type: 'core/prose',
          data: { html: `<p style="opacity:0.6;font-style:italic">Slot ${i + 1}</p>` },
        }])
      : undefined;

  const block: Block = {
    id: 'preview',
    type: id,
    data,
    children: previewChildren,
    slots: previewSlots,
  };

  const body = renderBlock(block, { registry });
  const assets = collectBlockAssets([block], registry);

  // Compose the full document with base typography + block CSS.
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    :root {
      --color-primary: #4f46e5;
      --color-primary-fg: #ffffff;
      --color-secondary: #f1f5f9;
      --color-secondary-fg: #0f172a;
      --color-bg: #ffffff;
      --color-bg-subtle: #f8fafc;
    }
    html, body {
      margin: 0; padding: 0;
      font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
      color: #0f172a;
      background: #ffffff;
      line-height: 1.5;
    }
    body { padding: 1rem; }
    img { max-width: 100%; height: auto; }
    /* Universal block runtime CSS */
    ${BLOCKS_RUNTIME_CSS}
    /* Concatenated block-type styles (used types + the draft) */
    ${assets.css}
  </style>
</head>
<body>${body}</body>
</html>`;
}

/**
 * Generate sample data for the preview from the schema. Each field type
 * gets a representative value so the rendered block looks plausible,
 * not just a string of [object Object]s.
 */
export function defaultSampleData(schema: FieldDefinition[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of schema) {
    if (f.default !== undefined) {
      out[f.name] = f.default;
      continue;
    }
    switch (f.type) {
      case 'text':
        out[f.name] = f.placeholder ?? sampleTextFor(f.name);
        break;
      case 'textarea':
        out[f.name] = `Sample ${f.label.toLowerCase()} content for the preview.`;
        break;
      case 'richtext':
        out[f.name] = `<p>Sample <strong>${f.label.toLowerCase()}</strong>. The preview renders block templates with placeholder content so you can iterate on styles.</p>`;
        break;
      case 'select':
        out[f.name] = f.options?.[0] ?? '';
        break;
      case 'boolean':
        out[f.name] = false;
        break;
      case 'number':
        out[f.name] = f.min ?? 1;
        break;
      case 'color':
        out[f.name] = '';
        break;
      case 'image':
        out[f.name] = 'https://placehold.co/640x360/e2e8f0/64748b?text=Image';
        break;
      case 'url':
        out[f.name] = '#';
        break;
      case 'email':
        out[f.name] = 'sample@example.com';
        break;
      case 'date':
        out[f.name] = new Date().toISOString().slice(0, 10);
        break;
      case 'datetime':
        out[f.name] = new Date().toISOString();
        break;
      case 'icon':
        out[f.name] = 'star';
        break;
      case 'array':
        out[f.name] = sampleArray(f);
        break;
      default:
        out[f.name] = '';
    }
  }
  return out;
}

/**
 * Heuristic-friendly text samples for common field names — looks better
 * in the preview than "Sample heading" for everything.
 */
function sampleTextFor(name: string): string {
  const lower = name.toLowerCase();
  // Check more-specific patterns BEFORE generic ones — `cta_label` should
  // hit the CTA branch, not the eyebrow/label fallback.
  if (lower.includes('button') || lower === 'cta' || lower.startsWith('cta_') || lower.endsWith('_cta')) return 'Get started';
  if (lower.includes('heading') || lower.includes('title')) return 'Sample heading';
  if (lower.includes('eyebrow') || lower === 'label' || lower.endsWith('_label')) return 'Eyebrow';
  if (lower.includes('name')) return 'Jane Doe';
  if (lower.includes('role')) return 'Senior Designer';
  if (lower.includes('company')) return 'Acme Inc';
  if (lower.includes('price')) return '$29';
  if (lower.includes('period')) return '/month';
  if (lower.includes('badge')) return 'Popular';
  return `Sample ${name}`;
}

/**
 * Pre-fill array fields with a couple of plausible items so repeater /
 * gallery / pricing-table-style blocks have something to render.
 */
function sampleArray(f: FieldDefinition): Record<string, unknown>[] {
  const inner = f.fields ?? [];
  if (inner.length === 0) {
    return [{ value: 'Item 1' }, { value: 'Item 2' }, { value: 'Item 3' }];
  }
  const item = (i: number): Record<string, unknown> => {
    const obj: Record<string, unknown> = {};
    for (const sub of inner) {
      if (sub.default !== undefined) { obj[sub.name] = sub.default; continue; }
      switch (sub.type) {
        case 'text':     obj[sub.name] = `${sampleTextFor(sub.name)} ${i + 1}`; break;
        case 'richtext': obj[sub.name] = `<p>Sample text ${i + 1}.</p>`; break;
        case 'image':    obj[sub.name] = 'https://placehold.co/200x200/e2e8f0/64748b?text=Img'; break;
        case 'url':      obj[sub.name] = '#'; break;
        case 'boolean':  obj[sub.name] = true; break;
        case 'number':   obj[sub.name] = i + 1; break;
        case 'icon':     obj[sub.name] = 'star'; break;
        case 'select':   obj[sub.name] = sub.options?.[0] ?? ''; break;
        default:         obj[sub.name] = '';
      }
    }
    return obj;
  };
  return [item(0), item(1), item(2)];
}

function escapeForPre(s: string): string {
  return s.replace(/[<>&]/g, (c) => c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&amp;');
}

// ─── Styles ──────────────────────────────────────────────────────────────

const section: React.CSSProperties = {
  marginBottom: '1.5rem', padding: '1rem',
  border: '1px solid #2a2a30', borderRadius: 8, background: '#161618',
};
const sectionH: React.CSSProperties = {
  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
  margin: '0 0 .75rem', fontSize: '.95rem', color: '#e4e4e7',
};
const widthToolbar: React.CSSProperties = {
  display: 'flex', gap: 4, padding: 3, background: '#1f1f23',
  border: '1px solid #2a2a30', borderRadius: 6,
};
const widthBtn: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  padding: 4, background: 'transparent', border: 'none', borderRadius: 4,
  color: '#a1a1aa', cursor: 'pointer', minWidth: 28, minHeight: 24,
};
const widthBtnActive: React.CSSProperties = {
  background: '#3f3f46', color: '#fafafa',
};
const previewFrame: React.CSSProperties = {
  background: '#0a0a0d', border: '1px solid #2a2a30', borderRadius: 6,
  display: 'flex', justifyContent: 'center', overflow: 'auto', padding: 12,
};
const iframeStyle: React.CSSProperties = {
  border: 'none', background: 'white', minHeight: 240, height: 'auto',
  boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
};
const overridesToggle: React.CSSProperties = {
  marginTop: 10, padding: '.35rem .6rem', background: 'transparent',
  border: '1px solid #2a2a30', borderRadius: 6, color: '#a1a1aa',
  cursor: 'pointer', fontSize: '.8rem',
};
const overridesPanel: React.CSSProperties = {
  marginTop: 8, padding: 10, background: '#1f1f23',
  border: '1px solid #2a2a30', borderRadius: 6,
  display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8,
};
const overrideRow: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 2, fontSize: '.75rem',
  color: '#a1a1aa',
};
const overrideLabel: React.CSSProperties = {
  fontSize: '.7rem', textTransform: 'uppercase', letterSpacing: '0.04em',
};
const overrideInput: React.CSSProperties = {
  padding: '.3rem .5rem', background: '#0a0a0d', color: '#fafafa',
  border: '1px solid #2a2a30', borderRadius: 4, fontSize: '.8rem',
  width: '100%', boxSizing: 'border-box',
};
const muted: React.CSSProperties = { color: '#71717a', fontSize: '.8rem', margin: 0 };
