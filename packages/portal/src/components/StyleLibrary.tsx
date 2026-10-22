import { useMemo, useState } from 'react';
import type { BlockType, BreakpointWidths, SiteColors, SiteStyle, StyleBreakpoint, StyleProps, StyleShadow, StyleTarget } from '@typeroll/shared';
import {
  COLOR_TOKENS,
  STYLE_BREAKPOINTS,
  STYLE_ELEMENT_ROLES,
  STYLE_SHADOWS,
  STYLE_TARGETS,
  blockPartIndex,
  breakpointPreviewWidth,
  siteStyleLibraryErrors,
  siteStylesCss,
  styleContrastReport,
  validateSiteStyle,
} from '@typeroll/shared';

/** A block part a style can apply to site-wide (`SiteStyle.parts`). */
export interface BlockPartChoice {
  /** `<block type id>.<part name>`, e.g. `core/rich_heading.link`. */
  ref: string;
  blockLabel: string;
  partLabel: string;
  target: StyleTarget;
}

/** Every block part of the site's block types, sorted by block label (parts keep their declared order). */
export function blockPartChoices(registry: ReadonlyMap<string, BlockType>): BlockPartChoice[] {
  return [...blockPartIndex(registry)]
    .map(([ref, { type, part }]) => ({ ref, blockLabel: type.label || type.id, partLabel: part.label, target: part.target }))
    .sort((a, b) => a.blockLabel.localeCompare(b.blockLabel));
}

/** The style's `parts` after checking or unchecking `ref`; undefined when none is left. */
export function togglePart(parts: readonly string[] | undefined, ref: string, on: boolean): string[] | undefined {
  const next = on ? [...new Set([...(parts ?? []), ref])] : (parts ?? []).filter(item => item !== ref);
  return next.length ? next : undefined;
}

/**
 * Why the draft's block parts cannot be saved, as the server would say it:
 * a part of a kind the style does not target, a part the site does not have,
 * or a part another style already applies to.
 */
export function draftPartErrors(draft: SiteStyle, styles: readonly SiteStyle[], choices: readonly BlockPartChoice[], isNew: boolean): string[] {
  const errors: string[] = [];
  const byRef = new Map(choices.map(choice => [choice.ref, choice]));
  for (const ref of draft.parts ?? []) {
    const choice = byRef.get(ref);
    if (!choice) errors.push(`Block parts: ${ref} is not a block part on this site. Uncheck it.`);
    else if (!draft.targets.includes(choice.target)) errors.push(`Block parts: ${choice.blockLabel} · ${choice.partLabel} takes ${TARGET_LABEL[choice.target].toLowerCase()} styles. Tick ${TARGET_LABEL[choice.target]} under “Can be chosen for”, or uncheck the part.`);
  }
  if (draft.id && draft.parts?.length) {
    const library = isNew ? [...styles, draft] : styles.map(style => style.id === draft.id ? draft : style);
    errors.push(...siteStyleLibraryErrors(library).filter(error => error.includes('block part') && error.includes(`"${draft.id}"`)));
  }
  return errors;
}

interface Props {
  siteId: string;
  initialStyles: SiteStyle[];
  colors: SiteColors;
  breakpoints: BreakpointWidths;
  /** The site's render version: it decides the automatic on_* colours. */
  renderVersion: number;
  /** Theme tokens, content well and site base CSS, as the site renders them. */
  baseCss: string;
  canEdit: boolean;
  /** Block parts of the site's block types (blockPartChoices). */
  blockParts?: BlockPartChoice[];
}

type Tab = 'base' | StyleBreakpoint;
const TAB_LABEL: Record<Tab, string> = { base: 'Mobile', tablet: 'Tablet', laptop: 'Laptop', desktop: 'Desktop', wide: 'Wide' };
const TARGET_LABEL: Record<StyleTarget, string> = { text: 'Text', heading: 'Headings', list: 'Lists', button: 'Buttons', container: 'Sections and containers', link: 'Links', image: 'Images' };
const SAMPLE_IMAGE = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="160"><rect width="320" height="160" fill="#cbd5e1"/><circle cx="90" cy="70" r="28" fill="#94a3b8"/><path d="M0 160 120 80l80 50 50-30 70 60z" fill="#64748b"/></svg>')}`;
const isElementRole = (style: SiteStyle) => (STYLE_ELEMENT_ROLES as readonly string[]).includes(style.role ?? '');
const slugify = (name: string) => name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/^(\d)/, 's-$1').slice(0, 48) || 'style';

function sampleMarkup(style: SiteStyle): string {
  const cls = `s-${style.id}`;
  switch (style.role) {
    case 'body': return '<p>Body text sets the reading size and rhythm of the whole site. A second sentence shows how lines wrap.</p>';
    case 'link': return '<p>Text with <a href="#">a link</a> inside it.</p>';
    case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': return `<${style.role}>Heading sample text</${style.role}><p>Body text after the heading.</p>`;
  }
  const target = style.targets[0] ?? 'text';
  if (target === 'heading') return `<h2 class="${cls}">Heading with this style</h2>`;
  if (target === 'list') return `<ul class="${cls}"><li>First item</li><li>Second item</li></ul>`;
  if (target === 'button') return `<p><a class="${cls}" href="#">Button label</a></p>`;
  if (target === 'link') return `<p>Text with <a class="${cls}" href="#">a link in this style</a> inside it.</p>`;
  if (target === 'image') return `<p><img class="${cls}" src="${SAMPLE_IMAGE}" alt="Sample image" width="320" height="160"></p>`;
  if (target === 'container') return `<section class="${cls}"><h2>Section heading</h2><p>Section content.</p></section>`;
  return `<p class="${cls}">Sample text in this style. It wraps to show the line height.</p>`;
}

function emptyStyle(): SiteStyle {
  return { id: '', name: '', targets: ['text'], base: {} };
}

export default function StyleLibrary({ siteId, initialStyles, colors, breakpoints, renderVersion, baseCss, canEdit, blockParts = [] }: Props) {
  const [styles, setStyles] = useState(initialStyles);
  const [selected, setSelected] = useState<string | null>(initialStyles[0]?.id ?? null);
  const [draft, setDraft] = useState<SiteStyle | null>(initialStyles[0] ? structuredClone(initialStyles[0]) : null);
  const [isNew, setIsNew] = useState(false);
  const [tab, setTab] = useState<Tab>('base');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const [notes, setNotes] = useState<string[]>([]);

  const select = (style: SiteStyle) => { setSelected(style.id); setDraft(structuredClone(style)); setIsNew(false); setErrors([]); setMessage(''); };
  const startNew = () => { setSelected(null); setDraft(emptyStyle()); setIsNew(true); setTab('base'); setErrors([]); setMessage(''); };

  const [liveErrors, liveWarnings] = useMemo(() => {
    if (!draft) return [[], []];
    const { style, errors: shape } = validateSiteStyle(draft);
    if (!style) return [shape, []];
    const report = styleContrastReport(style, colors, { renderVersion });
    return [[...draftPartErrors(style, styles, blockParts, isNew), ...report.errors], report.warnings];
  }, [draft, colors, renderVersion, styles, blockParts, isNew]);

  const previewDoc = useMemo(() => {
    if (!draft?.id) return '';
    const css = siteStylesCss([draft], { breakpoints, colors, renderVersion });
    return `<!doctype html><html><head><meta name="viewport" content="width=device-width"><style>${baseCss}</style><style>${css}</style><style>body{margin:0;padding:16px}</style></head><body><main class="page-content">${sampleMarkup(draft)}</main></body></html>`;
  }, [draft, baseCss, breakpoints, colors, renderVersion]);

  const previewWidth = tab === 'base' ? 390 : breakpointPreviewWidth(tab, breakpoints);
  const props: StyleProps = draft ? (tab === 'base' ? draft.base : draft.at?.[tab] ?? {}) : {};
  const inherited: StyleProps = draft ? STYLE_BREAKPOINTS.slice(0, tab === 'base' ? 0 : STYLE_BREAKPOINTS.indexOf(tab))
    .reduce((acc, bp) => ({ ...acc, ...(draft.at?.[bp] ?? {}) }), { ...draft.base }) : {};

  function setProp<K extends keyof StyleProps>(key: K, value: StyleProps[K] | undefined) {
    if (!draft) return;
    const next = structuredClone(draft);
    const layer: StyleProps = tab === 'base' ? next.base : (next.at ??= {})[tab] ??= {};
    if (value === undefined || value === '' as never) delete layer[key]; else layer[key] = value;
    if (tab !== 'base' && next.at && !Object.keys(next.at[tab] ?? {}).length) delete next.at[tab];
    setDraft(next);
  }

  async function save() {
    if (!draft) return;
    setBusy(true); setErrors([]); setNotes([]); setMessage('');
    const body = JSON.parse(JSON.stringify({ ...draft, updated_at: undefined }));
    const response = await fetch(isNew ? `/api/sites/${siteId}/styles` : `/api/sites/${siteId}/styles/${encodeURIComponent(draft.id)}`, {
      method: isNew ? 'POST' : 'PATCH',
      headers: { 'content-type': 'application/json' },
      // PATCH merges per property; send explicit nulls for removed ones.
      body: JSON.stringify(isNew ? body : withRemovals(styles.find(s => s.id === draft.id), body)),
    });
    const result = await response.json().catch(() => ({}));
    setBusy(false);
    if (!response.ok) { setErrors(result.errors ?? [result.error ?? 'Could not save the style.']); return; }
    const saved = result.style as SiteStyle;
    setStyles(current => isNew ? [...current, saved] : current.map(s => s.id === saved.id ? saved : s));
    setSelected(saved.id); setDraft(structuredClone(saved)); setIsNew(false);
    setMessage('Saved. Pages using this style show the change in preview now and on the live site after the next deploy.');
    setNotes(result.warnings ?? []);
  }

  async function remove() {
    if (!draft || isNew || !confirm(`Delete "${draft.name}"? Blocks using it return to their default look.`)) return;
    setBusy(true);
    const response = await fetch(`/api/sites/${siteId}/styles/${encodeURIComponent(draft.id)}`, { method: 'DELETE' });
    setBusy(false);
    if (!response.ok) { setErrors(['Could not delete the style.']); return; }
    const rest = styles.filter(s => s.id !== draft.id);
    setStyles(rest);
    rest[0] ? select(rest[0]) : (setDraft(null), setSelected(null));
  }

  async function addStandard() {
    setBusy(true); setErrors([]); setNotes([]);
    const response = await fetch(`/api/sites/${siteId}/styles/standard`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    const result = await response.json().catch(() => ({}));
    setBusy(false);
    if (!response.ok) { setErrors(result.errors ?? [result.error ?? 'Could not add the standard styles.']); return; }
    setStyles(result.styles);
    if (!draft && result.styles[0]) select(result.styles[0]);
    const adjusted = result.adjusted?.length ? ` ${result.adjusted.length} use the body text colour because a palette colour is unreadable on the background; see below.` : '';
    setMessage((result.added.length ? `Added ${result.added.length} standard styles.` : 'All standard styles are already here.') + adjusted);
    setNotes(result.warnings ?? []);
  }

  const groups: [string, SiteStyle[]][] = [
    ['Site-wide: body text, headings and links', styles.filter(isElementRole)],
    ['Chosen per block', styles.filter(s => !isElementRole(s))],
  ];

  return (
    <div className="stack" style={{ gap: '1rem' }}>
    {errors.length > 0 && <ul role="alert" className="card" style={{ margin: 0, paddingLeft: '2rem', color: 'var(--color-danger)' }}>{errors.map(e => <li key={e}>{e}</li>)}</ul>}
    {/* One live region: the result and its notes are announced together. */}
    {(message || notes.length > 0) && <div role="status" className="stack" style={{ gap: '0.5rem' }}>
      {message && <p className="card" style={{ margin: 0, color: 'var(--color-success)' }}>{message}</p>}
      {notes.length > 0 && <ul className="card" style={{ margin: 0, paddingLeft: '2rem' }}>{notes.map(note => <li key={note}>{note}</li>)}</ul>}
    </div>}
    <style>{`.style-library{display:grid;grid-template-columns:minmax(220px,280px) minmax(0,1fr);gap:1.5rem;align-items:start}@media (max-width:900px){.style-library{grid-template-columns:minmax(0,1fr)}}`}</style>
    <div className="style-library">
      <aside className="card stack" style={{ gap: '.75rem' }}>
        {canEdit && <div className="row" style={{ gap: '.5rem', flexWrap: 'wrap' }}>
          <button type="button" className="btn btn--sm" onClick={startNew}>New style</button>
          <button type="button" className="btn btn--secondary btn--sm" disabled={busy} onClick={addStandard}>Add standard styles</button>
        </div>}
        {groups.map(([title, items]) => (
          <div key={title} className="stack" style={{ gap: '.25rem' }}>
            <p className="muted text-sm" style={{ margin: 0 }}>{title}</p>
            {!items.length && <p className="text-sm" style={{ margin: 0 }}>None yet.</p>}
            {items.map(style => (
              <button key={style.id} type="button" onClick={() => select(style)} aria-current={selected === style.id || undefined}
                style={{ display: 'block', width: '100%', textAlign: 'left', padding: '.4rem .5rem', borderRadius: 6, border: '1px solid var(--color-border)', background: selected === style.id ? 'var(--color-bg)' : 'var(--color-surface)', cursor: 'pointer', color: 'var(--color-text)' }}>
                <strong style={{ display: 'block', fontSize: '.875rem' }}>{style.name}</strong>
                <span className="muted text-sm">{style.role ? `Standard · ${style.role}` : style.targets.map(t => TARGET_LABEL[t]).join(', ')}</span>
              </button>
            ))}
          </div>
        ))}
      </aside>

      {draft ? (
        <section className="card stack">
          <div className="row" style={{ gap: '1rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div className="field" style={{ flex: '1 1 200px' }}>
              <label htmlFor="style-name">Name</label>
              <input id="style-name" value={draft.name} disabled={!canEdit} onChange={e => setDraft({ ...draft, name: e.target.value, ...(isNew ? { id: slugify(e.target.value) } : {}) })} />
            </div>
            <div className="field" style={{ flex: '0 1 200px' }}>
              <label htmlFor="style-id">Class</label>
              <input id="style-id" value={draft.id} disabled={!isNew || !canEdit} onChange={e => setDraft({ ...draft, id: e.target.value })} style={{ fontFamily: 'var(--font-mono)' }} />
            </div>
          </div>
          <div className="field">
            <label htmlFor="style-description">When to use it</label>
            <input id="style-description" value={draft.description ?? ''} disabled={!canEdit} onChange={e => setDraft({ ...draft, description: e.target.value || undefined })} />
          </div>
          {!isElementRole(draft) && (
            <fieldset className="row" style={{ gap: '1rem', flexWrap: 'wrap', border: 0, padding: 0 }}>
              <legend className="text-sm" style={{ fontWeight: 500, marginBottom: '.25rem' }}>Can be chosen for</legend>
              {STYLE_TARGETS.map(target => (
                <label key={target} className="text-sm" style={{ display: 'flex', gap: '.35rem', alignItems: 'center' }}>
                  <input type="checkbox" disabled={!canEdit} checked={draft.targets.includes(target)} onChange={e => setDraft({ ...draft, targets: e.target.checked ? [...draft.targets, target] : draft.targets.filter(t => t !== target) })} />
                  {TARGET_LABEL[target]}
                </label>
              ))}
            </fieldset>
          )}

          {!isElementRole(draft) && (
            <PartsPicker draft={draft} styles={styles} choices={blockParts} disabled={!canEdit} onChange={parts => setDraft({ ...draft, parts })} />
          )}

          <div role="tablist" aria-label="Screen size" className="row" style={{ gap: '.25rem', flexWrap: 'wrap' }}>
            {(['base', ...STYLE_BREAKPOINTS] as Tab[]).map(key => (
              <button key={key} type="button" role="tab" aria-selected={tab === key} onClick={() => setTab(key)}
                className={tab === key ? 'btn btn--sm' : 'btn btn--secondary btn--sm'}>
                {TAB_LABEL[key]}{key !== 'base' && draft.at?.[key] ? ' •' : ''}
              </button>
            ))}
          </div>
          <p className="muted text-sm" style={{ margin: 0 }}>
            {tab === 'base' ? 'Values for phones and everything above, unless a larger screen overrides them.' : `Overrides from ${breakpoints[tab]}px wide and up. Empty fields keep the smaller screen's value.`}
          </p>

          <PropsEditor props={props} inherited={inherited} disabled={!canEdit} onChange={setProp} />

          {liveErrors.length > 0 && <ul role="alert" style={{ margin: 0, color: 'var(--color-danger)' }}>{liveErrors.map(e => <li key={e}>{e}</li>)}</ul>}
          {liveWarnings.length > 0 && <ul role="status" style={{ margin: 0 }}>{liveWarnings.map(w => <li key={w}>{w}</li>)}</ul>}

          <div>
            <p className="muted text-sm" style={{ margin: '0 0 .25rem' }}>Preview at {previewWidth}px (fonts load on the site)</p>
            <div style={{ overflowX: 'auto', border: '1px solid var(--color-border)', borderRadius: 8, background: '#fff' }}>
              {previewDoc && <iframe title="Style preview" sandbox="" srcDoc={previewDoc} style={{ width: previewWidth, height: 220, border: 0, display: 'block' }} />}
            </div>
          </div>

          <details>
            <summary className="text-sm">Advanced CSS</summary>
            <p className="muted text-sm">Bare declarations apply to the style; use <code>&amp;</code> for its selector, e.g. <code>&amp;::before {'{'} content: "—" {'}'}</code>. Prefer the fields above.</p>
            <textarea rows={5} value={draft.css ?? ''} disabled={!canEdit} onChange={e => setDraft({ ...draft, css: e.target.value || undefined })} style={{ width: '100%', fontFamily: 'var(--font-mono)' }} />
          </details>

          {canEdit && <div className="row" style={{ gap: '.5rem' }}>
            <button type="button" className="btn" disabled={busy || liveErrors.length > 0 || !draft.id || !draft.name.trim()} onClick={save}>{isNew ? 'Create style' : 'Save style'}</button>
            {!isNew && <button type="button" className="btn btn--danger" disabled={busy} onClick={remove}>Delete</button>}
          </div>}
        </section>
      ) : (
        <section className="card"><p style={{ margin: 0 }}>Choose a style, or create one.</p></section>
      )}
    </div>
    </div>
  );
}

/** For PATCH: explicit nulls for properties and breakpoints that were removed. */
function withRemovals(before: SiteStyle | undefined, after: SiteStyle): Record<string, unknown> {
  const layer = (old: StyleProps | undefined, next: StyleProps | undefined) => ({
    ...Object.fromEntries(Object.keys(old ?? {}).filter(k => !(k in (next ?? {}))).map(k => [k, null])),
    ...(next ?? {}),
  });
  const at: Record<string, unknown> = {};
  for (const bp of STYLE_BREAKPOINTS) {
    if (after.at?.[bp]) at[bp] = layer(before?.at?.[bp], after.at[bp]);
    else if (before?.at?.[bp]) at[bp] = null;
  }
  return {
    name: after.name, targets: after.targets, description: after.description ?? null, css: after.css ?? null,
    base: layer(before?.base, after.base), at, hover: after.hover ?? null, parts: after.parts ?? null,
  };
}

function PropsEditor({ props, inherited, disabled, onChange }: {
  props: StyleProps; inherited: StyleProps; disabled: boolean;
  onChange: <K extends keyof StyleProps>(key: K, value: StyleProps[K] | undefined) => void;
}) {
  const text = (key: 'size' | 'line_height' | 'letter_spacing' | 'space_before' | 'space_after' | 'padding' | 'max_width' | 'radius' | 'gap', label: string, hint: string) => (
    <div className="field">
      <label>{label}</label>
      <input aria-label={label} value={(props[key] as string) ?? ''} placeholder={(inherited[key] as string) ?? hint} disabled={disabled} onChange={e => onChange(key, e.target.value || undefined)} />
    </div>
  );
  const select = <K extends 'font' | 'transform' | 'align' | 'decoration' | 'shadow'>(key: K, label: string, options: string[]) => (
    <div className="field">
      <label>{label}</label>
      <select aria-label={label} value={(props[key] as string) ?? ''} disabled={disabled} onChange={e => onChange(key, (e.target.value || undefined) as StyleProps[K])}>
        <option value="">{inherited[key] ? `Inherit (${inherited[key]})` : 'Default'}</option>
        {options.map(o => <option key={o} value={o}>{o}</option>)}
      </select>
    </div>
  );
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: '.75rem' }}>
      {select('font', 'Font', ['heading', 'body', 'mono', 'inherit'])}
      {text('size', 'Size', 'e.g. 1.125rem')}
      <div className="field">
        <label>Weight</label>
        <select aria-label="Weight" value={props.weight ?? ''} disabled={disabled} onChange={e => onChange('weight', e.target.value ? Number(e.target.value) : undefined)}>
          <option value="">{inherited.weight ? `Inherit (${inherited.weight})` : 'Default'}</option>
          {[300, 400, 500, 600, 700, 800, 900].map(w => <option key={w} value={w}>{w}</option>)}
        </select>
      </div>
      {text('line_height', 'Line height', 'e.g. 1.5')}
      {text('letter_spacing', 'Letter spacing', 'e.g. 0.08em')}
      {select('transform', 'Case', ['none', 'uppercase', 'lowercase', 'capitalize'])}
      <ColorField label="Text colour" value={props.color} inherited={inherited.color} disabled={disabled} onChange={v => onChange('color', v)} />
      <ColorField label="Background" value={props.background} inherited={inherited.background} disabled={disabled} onChange={v => onChange('background', v)} />
      {select('align', 'Alignment', ['left', 'center', 'right', 'start', 'end', 'justify'])}
      {select('decoration', 'Underline', ['none', 'underline'])}
      {text('space_before', 'Space before', 'e.g. 1rem')}
      {text('space_after', 'Space after', 'e.g. 0.75rem')}
      {text('padding', 'Padding', 'e.g. 1rem 1.5rem')}
      {text('max_width', 'Max width', 'e.g. 40rem')}
      {text('radius', 'Corner radius', 'e.g. 0.5rem')}
      {text('gap', 'Gap between items', 'e.g. 1rem or 1rem 2rem')}
      {select('shadow', 'Shadow', Object.keys(STYLE_SHADOWS) as StyleShadow[])}
      <div className="field">
        <label>Opacity</label>
        <input aria-label="Opacity" type="number" min={0} max={1} step={0.05} value={props.opacity ?? ''} placeholder={inherited.opacity !== undefined ? String(inherited.opacity) : '0 to 1, e.g. 0.8'} disabled={disabled}
          onChange={e => onChange('opacity', e.target.value === '' ? undefined : Number(e.target.value))} />
      </div>
      <div className="field">
        <label>Italic</label>
        <select aria-label="Italic" value={props.italic === undefined ? '' : String(props.italic)} disabled={disabled} onChange={e => onChange('italic', e.target.value === '' ? undefined : e.target.value === 'true')}>
          <option value="">Default</option><option value="true">Italic</option><option value="false">Upright</option>
        </select>
      </div>
    </div>
  );
}

function ColorField({ label, value, inherited, disabled, onChange }: { label: string; value?: string; inherited?: string; disabled: boolean; onChange: (v: string | undefined) => void }) {
  const isToken = !value || (COLOR_TOKENS as readonly string[]).includes(value);
  return (
    <div className="field">
      <label>{label}</label>
      <select aria-label={label} value={isToken ? value ?? '' : 'custom'} disabled={disabled} onChange={e => onChange(e.target.value === 'custom' ? '#000000' : e.target.value || undefined)}>
        <option value="">{inherited ? `Inherit (${inherited})` : 'Default'}</option>
        {COLOR_TOKENS.map(token => <option key={token} value={token}>{token.replace('_', ' ')}</option>)}
        <option value="custom">Custom…</option>
      </select>
      {!isToken && <input value={value} disabled={disabled} onChange={e => onChange(e.target.value)} aria-label={`${label} value`} style={{ marginTop: '.25rem', fontFamily: 'var(--font-mono)' }} />}
    </div>
  );
}

/**
 * Block parts the style applies to on every block of that type, grouped by
 * block. Only parts of a kind the style targets are offered; a stored part
 * that no longer fits stays listed so it can be unchecked.
 */
function PartsPicker({ draft, styles, choices, disabled, onChange }: {
  draft: SiteStyle; styles: readonly SiteStyle[]; choices: readonly BlockPartChoice[]; disabled: boolean;
  onChange: (parts: string[] | undefined) => void;
}) {
  const selected = draft.parts ?? [];
  const fitting = choices.filter(choice => draft.targets.includes(choice.target) || selected.includes(choice.ref));
  const known = new Set(choices.map(choice => choice.ref));
  const unknown = selected.filter(ref => !known.has(ref));
  const groups = new Map<string, BlockPartChoice[]>();
  for (const choice of fitting) {
    const typeId = choice.ref.slice(0, choice.ref.lastIndexOf('.'));
    groups.set(typeId, [...(groups.get(typeId) ?? []), choice]);
  }
  const owners = new Map<string, string>();
  for (const style of styles) if (style.id !== draft.id) for (const ref of style.parts ?? []) owners.set(ref, style.name);
  const checkbox = (ref: string, label: React.ReactNode) => (
    <label key={ref} className="text-sm" style={{ display: 'flex', gap: '.35rem', alignItems: 'center', minHeight: 32 }}>
      <input type="checkbox" disabled={disabled} checked={selected.includes(ref)} onChange={e => onChange(togglePart(draft.parts, ref, e.target.checked))} />
      {label}
    </label>
  );
  return (
    <fieldset className="stack" style={{ gap: '.5rem', border: 0, padding: 0, margin: 0 }} aria-describedby="style-parts-help">
      <legend className="text-sm" style={{ fontWeight: 500, marginBottom: '.25rem' }}>Block parts</legend>
      <p id="style-parts-help" className="muted text-sm" style={{ margin: 0 }}>
        Applies this style to these parts of every block of that type. A block can still choose another style for a part under Appearance. A part takes one site-wide style.
      </p>
      {!groups.size && !unknown.length && <p className="text-sm" style={{ margin: 0 }}>
        {draft.targets.length ? `No block on this site has parts for ${draft.targets.map(target => TARGET_LABEL[target].toLowerCase()).join(', ')}.` : 'Choose what the style can be chosen for first.'}
      </p>}
      {(groups.size > 0 || unknown.length > 0) && <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '.5rem 1rem' }}>
        {[...groups].map(([typeId, items]) => (
          <fieldset key={typeId} style={{ border: '1px solid var(--color-border)', borderRadius: 6, padding: '.35rem .6rem', margin: 0, minWidth: 0 }}>
            <legend className="text-sm" style={{ fontWeight: 500, padding: '0 .25rem' }}>{items[0]!.blockLabel}</legend>
            {items.map(choice => checkbox(choice.ref, <span>
              {choice.partLabel}
              {!draft.targets.includes(choice.target) && <span style={{ color: 'var(--color-danger)' }}> (takes {TARGET_LABEL[choice.target].toLowerCase()} styles)</span>}
              {owners.has(choice.ref) && <span className="muted"> · site-wide: {owners.get(choice.ref)}</span>}
            </span>))}
          </fieldset>
        ))}
        {unknown.length > 0 && (
          <fieldset style={{ border: '1px solid var(--color-border)', borderRadius: 6, padding: '.35rem .6rem', margin: 0, minWidth: 0 }}>
            <legend className="text-sm" style={{ fontWeight: 500, padding: '0 .25rem' }}>Not on this site</legend>
            {unknown.map(ref => checkbox(ref, <span style={{ fontFamily: 'var(--font-mono)' }}>{ref}</span>))}
          </fieldset>
        )}
      </div>}
    </fieldset>
  );
}
