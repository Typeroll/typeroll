import { useContext, useEffect, useId, useState } from 'react';
import type { BlockPart, BlockType, Breakpoint, FieldDefinition, ResponsiveBreakpoints, SiteStyle } from '@typeroll/shared';
import {
  COLOR_TOKENS, TOKEN_SCALES, tokenScale, scaleValue, validColor, BREAKPOINTS, BREAKPOINTS_ABOVE_MOBILE, blockPartRef, instanceStyleParts, resolveBreakpointWidths, responsiveBreakpointsError, styleFitsPart, stylesForTarget,
} from '@typeroll/shared';
import { Monitor } from 'lucide-react';
import RichTextInput from './RichTextInput';
import ContentReferenceInput from './ContentReferenceInput';
import ArrayFieldInput from './ArrayFieldInput';
import IconPicker from './IconPicker';
import LinkFieldInput from './LinkFieldInput';
import MediaPicker from './MediaPicker';
import { loadInternalPages, type InternalPageOption } from './internal-pages';

import { EditedBlockTypeContext, GlobalBlocksContext, RenderVersionContext, SiteStylesContext } from './editor-context';
export { EditedBlockTypeContext, fieldAvailable, GlobalBlocksContext, RenderVersionContext, SiteStylesContext } from './editor-context';

export default function FieldInput({
  siteId, field, value, onChange, responsive, activeBp, hasOwn, triState = false, siteWidths,
}: {
  siteId?: string;
  siteWidths?: ResponsiveBreakpoints | null;
  field: FieldDefinition;
  value: unknown;
  onChange: (v: unknown) => void;
  responsive?: boolean;
  activeBp?: Breakpoint;
  hasOwn?: boolean;
  triState?: boolean;
}) {
  const fieldId = useId();
  const helpId = `${fieldId}-help`;
  // Help text sits between the label and the control and describes the control.
  const help = field.help ? <p id={helpId} className="field-help" style={fieldHelp}>{field.help}</p> : null;
  const describedBy = field.help ? helpId : undefined;
  const labelOnly = (
    <label htmlFor={fieldId} style={fieldLabel}>
      {field.label}{field.required && <span aria-hidden="true"> *</span>}
      {responsive && activeBp && (
        <ResponsiveBadge activeBp={activeBp} hasOwn={!!hasOwn} onReset={() => onChange('')} />
      )}
    </label>
  );
  const label = <>{labelOnly}{help}</>;
  const v = (value ?? '') as string;
  const siteStyles = useContext(SiteStylesContext);
  const globalBlocks = useContext(GlobalBlocksContext);
  const editedType = useContext(EditedBlockTypeContext);
  const renderVersion = useContext(RenderVersionContext);
  switch (field.type) {
    case 'part_styles':
      // Generated for block types with parts; never a free-text value.
      return <PartStylesInput id={fieldId} siteId={siteId} field={field} value={value} onChange={onChange} help={help} describedBy={describedBy}
        type={editedType} styles={siteStyles ?? []} parts={editedType ? stylableParts(editedType, renderVersion) : []} />;
    case 'global_block': {
      const options = globalBlocks?.blocks ?? [];
      const current = options.find(block => block.id === v);
      return (
        <div style={fieldGroup}>
          {label}
          <select id={fieldId} aria-label={field.label} value={v} onChange={(e) => onChange(e.target.value || undefined)} style={selectInput}>
            <option value="">Choose a global block…</option>
            {options.map(block => <option key={block.id} value={block.id}>{block.name}{block.status === 'draft' ? ' (draft, not shown)' : ''}</option>)}
            {v && !current && <option value={v}>{v} (missing)</option>}
          </select>
          {current?.status === 'draft' && <p role="alert" style={{ fontSize: '.8rem', color: '#fcd34d', margin: '.25rem 0 0' }}>Draft global blocks are not shown on pages. Publish it in the global block's editor.</p>}
          {v && globalBlocks && <a href={`/app/sites/${globalBlocks.siteId}/partials/${encodeURIComponent(v)}`} target="_blank" rel="noopener" style={{ fontSize: '.8rem', color: '#a5b4fc' }}>Edit this global block (changes every page using it)</a>}
        </div>
      );
    }
    case 'style': {
      const options = stylesForTarget(siteStyles ?? [], field.style_target ?? 'text');
      const missing = v && !options.some(style => style.id === v);
      const roleDefault = field.style_default_role ? (siteStyles ?? []).find(style => style.role === field.style_default_role) : undefined;
      return (
        <div style={fieldGroup}>
          {label}
          <select id={fieldId} aria-label={field.label} value={v} onChange={(e) => onChange(e.target.value || undefined)} style={selectInput}>
            <option value="">{roleDefault ? `Site default (${roleDefault.name})` : 'Default look'}</option>
            {options.map(style => <option key={style.id} value={style.id}>{style.name}</option>)}
            {missing && <option value={v}>{v} (missing style)</option>}
          </select>
          {siteId && <a href={`/app/sites/${siteId}/styles`} target="_blank" rel="noopener" style={{ fontSize: '.75rem', color: '#a5b4fc' }}>Manage styles</a>}
        </div>
      );
    }
    case 'link':
      return <div style={fieldGroup} role="group" aria-labelledby={`${fieldId}-legend`} aria-describedby={describedBy}>
        <span id={`${fieldId}-legend`} style={fieldLabel}>{field.label}{field.required && <span aria-hidden="true"> *</span>}</span>
        {help}
        <LinkFieldInput id={fieldId} siteId={siteId} label={field.label} value={value} onChange={onChange} />
      </div>;
    case 'icon':
      return <div style={fieldGroup}>{label}<IconPicker id={fieldId} label={field.label} value={typeof value === 'string' ? value : ''} onChange={onChange} /></div>;
    case 'image':
      if (!siteId) break;
      return <div style={fieldGroup}>{label}<MediaPicker id={fieldId} siteId={siteId} theme="dark" value={typeof value === 'string' ? value : ''} onChange={onChange} /></div>;
    case 'page_ref':
    case 'page_ref_list':
    case 'content_type_ref':
      return <div style={fieldGroup}>{label}{siteId
        ? <ContentReferenceInput id={fieldId} siteId={siteId} value={value} onChange={onChange} multiple={field.type === 'page_ref_list'} contentType={field.ref_content_type} types={field.type === 'content_type_ref'} />
        : <p>Choose a site to select content.</p>}</div>;
    case 'richtext':
      return <div style={fieldGroup}>{label}<RichTextInput id={fieldId} label={field.label} required={field.required} value={v} onChange={onChange} /></div>;
    case 'textarea': {
      // The core/html block's `html` field holds whole chunks of markup —
      // give it (and any code-ish field) a near-viewport editing surface
      // instead of a cramped 4-row box. Everything stays resizable.
      const isCode = field.name === 'html' || field.name === 'css' || field.name === 'code';
      const tallStyle: React.CSSProperties = isCode
        ? { ...textareaInput, minHeight: '75vh' }
        : textareaInput;
      return (
        <div style={fieldGroup}>
          {label}
          <textarea id={fieldId} aria-label={field.label} aria-required={field.required || undefined} aria-describedby={describedBy}
            rows={isCode ? 24 : 4}
            value={v}
            placeholder={field.placeholder}
            onChange={(e) => onChange(e.target.value)}
            style={tallStyle}
          />
        </div>
      );
    }
    case 'select':
      return (
        <div style={fieldGroup}>
          {label}
          <select id={fieldId} aria-label={field.label} aria-required={field.required || undefined} aria-describedby={describedBy} value={v} onChange={(e) => onChange(e.target.value)} style={selectInput}>
            {!field.required && field.default == null && <option value="">{field.editor_group ? 'Default' : 'Choose…'}</option>}
            {(field.options ?? []).map((opt, index) => (
              <option key={opt} value={opt}>{field.option_labels?.[index] ?? opt}</option>
            ))}
          </select>
        </div>
      );
    case 'multiselect': {
      const selected = Array.isArray(value) ? value : [];
      return <fieldset style={{ ...fieldGroup, border: 0, padding: 0 }}>
        <legend style={fieldLabel}>{field.label}{field.required ? ' *' : ''}</legend>
        {help}
        {(field.options ?? []).map((option, index) => <label key={option} style={{ display: 'flex', gap: 8, alignItems: 'center', minHeight: 44 }}>
          <input type="checkbox" checked={selected.includes(option)} onChange={event => onChange(event.target.checked ? [...selected, option] : selected.filter(item => item !== option))} />
          {field.option_labels?.[index] ?? option}
        </label>)}
      </fieldset>;
    }
    case 'boolean':
      if (triState) return <fieldset style={{ ...fieldGroup, border: 0, padding: 0 }}>
        <legend style={fieldLabel}>{field.label}</legend>
        {[true, false].map(answer => <label key={String(answer)} style={{ display: 'flex', gap: 8, alignItems: 'center', minHeight: 44 }}>
          <input type="radio" name={fieldId} checked={value === answer} onChange={() => onChange(answer)} />{answer ? 'Yes' : 'No'}
        </label>)}
        <button type="button" style={smallActionBtn} onClick={() => onChange(null)}>Clear answer</button>
      </fieldset>;
      return (
        <div style={fieldGroup}>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: '.85rem' }}>
            <input id={fieldId} aria-label={field.label} aria-required={field.required || undefined}
              type="checkbox"
              checked={!!value}
              onChange={(e) => onChange(e.target.checked)}
              aria-describedby={describedBy}
            />
            {field.label}
          </label>
          {help}
        </div>
      );
    case 'color':
      return <div style={fieldGroup}>{label}<PaletteField id={fieldId} label={field.label ?? field.name} value={v} onChange={onChange} /></div>;
    case 'number': {
      const scale = tokenScale(field);
      return <div style={fieldGroup}>{label}{scale
        ? <ScaleField id={fieldId} field={field} scale={scale} value={value} onChange={onChange} />
        : <input id={fieldId} aria-label={field.label} aria-required={field.required || undefined} aria-describedby={describedBy}
            type="number" min={field.min} max={field.max} step="any" value={(value as number) ?? ''}
            onChange={e => onChange(e.target.value === '' ? '' : Number(e.target.value))} style={textInput} />}
      </div>;
    }
    case 'list':
    case 'list_simple':
      return (
        <div style={fieldGroup}>
          {label}
          <textarea id={fieldId} aria-label={field.label} aria-required={field.required || undefined}
            rows={5}
            value={Array.isArray(value) ? value.map(String).join('\n') : ''}
            placeholder={field.placeholder ?? 'One value per line'}
            onChange={(e) => onChange(e.target.value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean))}
            style={textareaInput}
          />
        </div>
      );
    case 'array':
      return (
        (field.fields ?? []).some(child => child.name !== field.item_key)
          ? <ArrayFieldInput
            siteId={siteId}
            triState={triState}
            field={field}
            value={Array.isArray(value) ? value : []}
            onChange={onChange}
            label={labelOnly}
            help={help}
            describedBy={describedBy}
          />
          : <JsonFieldInput value={Array.isArray(value) ? value : []} onChange={onChange} label={label} expected="array" />
      );
    case 'object':
      if (field.name === 'responsive_breakpoints') return <BlockWidthsInput value={value} siteWidths={siteWidths} onChange={onChange} />;
      return (
        <ObjectFieldInput
          siteId={siteId}
          triState={triState}
          field={field}
          value={value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}}
          onChange={onChange}
          label={field.fields?.length ? labelOnly : label}
          help={field.fields?.length ? help : null}
        />
      );
    case 'url':
      return (
        <UrlFieldInput
          siteId={siteId}
          triState={triState}
          field={field}
          value={v}
          onChange={onChange}
          label={label}
        />
      );
    default:
      break;
  }
  return (
    <div style={fieldGroup}>
      {label}
      <input id={fieldId} aria-label={field.label} aria-required={field.required || undefined} aria-describedby={describedBy}
        type={field.type === 'email' ? 'email' : field.type === 'date' ? 'date' : field.type === 'datetime' ? 'datetime-local' : 'text'}
        value={v}
        placeholder={field.placeholder}
        onChange={(e) => onChange(e.target.value)}
        style={textInput}
      />
    </div>
  );
}

/** Parts an instance may style at the site's render version; every one when no editor sets the version. */
export function stylableParts(type: Pick<BlockType, 'parts'>, renderVersion: number | null): BlockPart[] {
  return renderVersion === null ? (type.parts ?? []).filter(part => !part.style_field) : instanceStyleParts(type, renderVersion);
}

/**
 * The `part_styles` value after choosing `styleId` for `part` (empty: the
 * site default). Only parts the instance may style are kept, and an empty
 * map becomes undefined so the field is removed from the block data.
 */
export function setPartStyle(current: unknown, part: string, styleId: string, parts: readonly string[]): Record<string, string> | undefined {
  const next: Record<string, string> = {};
  if (current && typeof current === 'object' && !Array.isArray(current)) {
    for (const name of parts) {
      const id = (current as Record<string, unknown>)[name];
      if (typeof id === 'string' && id) next[name] = id;
    }
  }
  if (styleId && parts.includes(part)) next[part] = styleId;
  else delete next[part];
  return Object.keys(next).length ? next : undefined;
}

/** One style picker per part of the block that an instance may style (`part_styles`). */
function PartStylesInput({ id, siteId, field, value, onChange, help, describedBy, type, styles, parts }: {
  id: string;
  siteId?: string;
  field: FieldDefinition;
  value: unknown;
  onChange: (value: unknown) => void;
  help: React.ReactNode;
  describedBy?: string;
  type: Pick<BlockType, 'id' | 'parts'> | null;
  styles: readonly SiteStyle[];
  parts: readonly BlockPart[];
}) {
  if (!type || !parts.length) return null;
  const current = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const names = parts.map(part => part.name);
  return (
    <fieldset style={{ ...fieldGroup, border: 0, padding: 0, margin: '0 0 0.75rem' }} aria-describedby={describedBy}>
      <legend style={{ ...fieldLabel, padding: 0 }}>{field.label}</legend>
      {help}
      {parts.map(part => {
        const controlId = `${id}-${part.name}`;
        const options = stylesForTarget(styles, part.target);
        const stored = current[part.name];
        const selected = typeof stored === 'string' ? stored : '';
        const missing = selected && !options.some(style => style.id === selected);
        const ref = blockPartRef(type.id, part.name);
        const siteWide = styles.find(style => style.parts?.includes(ref) && styleFitsPart(style, part));
        return (
          <div key={part.name} style={{ marginBottom: 6 }}>
            <label htmlFor={controlId} style={fieldLabel}>{part.label}</label>
            <select id={controlId} value={selected} onChange={(e) => onChange(setPartStyle(current, part.name, e.target.value, names))} style={selectInput}>
              <option value="">{siteWide ? `Site default (${siteWide.name})` : 'Site default'}</option>
              {options.map(style => <option key={style.id} value={style.id}>{style.name}</option>)}
              {missing && <option value={selected}>{selected} (missing style)</option>}
            </select>
          </div>
        );
      })}
      {siteId && <a href={`/app/sites/${siteId}/styles`} target="_blank" rel="noopener" style={{ fontSize: '.75rem', color: '#a5b4fc' }}>Manage styles</a>}
    </fieldset>
  );
}

/** Save all widths together so autosave never persists a half-edited map. */
function BlockWidthsInput({ value, siteWidths, onChange }: { value: unknown; siteWidths?: ResponsiveBreakpoints | null; onChange: (value: unknown) => void }) {
  const initial = () => Object.fromEntries(BREAKPOINTS_ABOVE_MOBILE.map(key => [key, String(resolveBreakpointWidths(value ?? siteWidths)[key])]));
  const [draft, setDraft] = useState(initial);
  useEffect(() => setDraft(initial()), [JSON.stringify(value), JSON.stringify(siteWidths)]);
  const next = Object.fromEntries(BREAKPOINTS_ABOVE_MOBILE.map(key => [key, Number(draft[key])]));
  const error = responsiveBreakpointsError(next);
  return <details style={fieldGroup}>
    <summary>Block viewport widths {value ? '(custom)' : '(Site default)'}</summary>
    <p>Overrides only this block. Child blocks and other components keep their own widths.</p>
    {BREAKPOINTS_ABOVE_MOBILE.map(key => <label key={key} style={fieldLabel}>
      {key} starts at (px)
      <input aria-label={`Block ${key} starts at (px)`} type="number" min={320} max={2560} step={1}
        value={draft[key]} style={textInput} onChange={event => setDraft(current => ({ ...current, [key]: event.target.value }))} />
    </label>)}
    {error && <p role="alert">Use four increasing whole numbers between 320 and 2560.</p>}
    <button type="button" disabled={!!error} onClick={() => onChange(next)}>Apply block widths</button>
    <button type="button" onClick={() => onChange(null)}>Use Site widths</button>
  </details>;
}

function ObjectFieldInput({
  siteId, field, value, onChange, label, help, triState,
}: {
  siteId?: string;
  field: FieldDefinition;
  value: Record<string, unknown>;
  onChange: (value: unknown) => void;
  label: React.ReactNode;
  help?: React.ReactNode;
  triState?: boolean;
}) {
  if (!field.fields?.length) {
    return <JsonFieldInput value={value} onChange={onChange} label={label} expected="object" />;
  }
  return (
    <fieldset style={{ ...fieldGroup, border: '1px solid #2a2a30', borderRadius: 6, padding: 10 }}>
      <legend style={{ padding: '0 4px' }}>{label}</legend>
      {help}
      {(field.fields ?? []).map((child) => (
        <FieldInput
          key={child.name}
          siteId={siteId}
          triState={triState}
          field={child}
          value={value[child.name]}
          onChange={(next) => onChange({ ...value, [child.name]: next })}
        />
      ))}
    </fieldset>
  );
}

function JsonFieldInput({
  value, onChange, label, expected,
}: {
  value: unknown;
  onChange: (value: unknown) => void;
  label: React.ReactNode;
  triState?: boolean;
  expected: 'array' | 'object';
}) {
  const serialized = JSON.stringify(value, null, 2);
  const [draft, setDraft] = useState(serialized);
  const [error, setError] = useState('');
  useEffect(() => setDraft(serialized), [serialized]);

  const commit = () => {
    try {
      const parsed: unknown = JSON.parse(draft);
      const valid = expected === 'array'
        ? Array.isArray(parsed)
        : Boolean(parsed && typeof parsed === 'object' && !Array.isArray(parsed));
      if (!valid) throw new Error(`Expected a JSON ${expected}`);
      setError('');
      onChange(parsed);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : `Invalid JSON ${expected}`);
    }
  };

  return (
    <div style={fieldGroup}>
      {label}
      <textarea
        rows={8}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        spellCheck={false}
        style={textareaInput}
      />
      {error && <span role="alert" style={{ color: '#fca5a5', fontSize: '.75rem' }}>{error}</span>}
    </div>
  );
}

function UrlFieldInput({
  siteId, field, value, onChange, label, triState,
}: {
  siteId?: string;
  field: FieldDefinition;
  value: string;
  onChange: (value: unknown) => void;
  label: React.ReactNode;
  triState?: boolean;
}) {
  const [pages, setPages] = useState<InternalPageOption[]>([]);
  useEffect(() => {
    if (!siteId) return;
    let active = true;
    loadInternalPages(siteId)
      .then((options) => { if (active) setPages(options); })
      .catch(() => { if (active) setPages([]); });
    return () => { active = false; };
  }, [siteId]);

  return (
    <div style={fieldGroup}>
      {label}
      <input type="text" inputMode="url" value={value} placeholder={field.placeholder} onChange={(e) => onChange(e.target.value)} style={textInput} />
      {siteId && pages.length > 0 && (
        <select
          aria-label={`Choose internal page for ${field.label}`}
          value={pages.some((page) => page.url === value) ? value : ''}
          onChange={(e) => { if (e.target.value) onChange(e.target.value); }}
          style={{ ...selectInput, marginTop: 6 }}
        >
          <option value="">Choose internal page…</option>
          {pages.map((page) => <option key={page.id} value={page.url}>{page.title} ({page.url})</option>)}
        </select>
      )}
    </div>
  );
}

// ─── Responsive field badge ─────────────────────────────────────────────

// Shows which breakpoint a responsive field is currently being edited at,
// whether the shown value is inherited from a smaller breakpoint, and (when
// this breakpoint has its own value) a button to clear the override back to
// inheritance.
function ResponsiveBadge({
  activeBp, hasOwn, onReset,
}: {
  activeBp: Breakpoint;
  hasOwn: boolean;
  onReset: () => void;
}) {
  const label = BREAKPOINTS[activeBp].label;
  return (
    <span style={respBadge} title={`Value for ${label}. Use the device controls to set other breakpoints.`}>
      <Monitor size={10} style={{ opacity: 0.7 }} />
      <span>{hasOwn ? label : `${label} · inherited`}</span>
      {hasOwn && (
        <button type="button" onClick={onReset} style={respReset} title="Reset to inherited value">
          ✕
        </button>
      )}
    </span>
  );
}

export const fieldGroup: React.CSSProperties = { marginBottom: '0.75rem' };
const fieldHelp: React.CSSProperties = { margin: '0 0 6px', fontSize: '.78rem', lineHeight: 1.45, color: 'var(--color-text-muted)' };
export const fieldLabel: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6,
  fontSize: '.75rem', opacity: 0.7, marginBottom: 4,
};
const respBadge: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 4,
  fontSize: '.65rem', color: '#a5b4fc', background: 'rgba(99,102,241,0.12)',
  border: '1px solid rgba(99,102,241,0.3)', borderRadius: 4, padding: '1px 5px',
  whiteSpace: 'nowrap',
};
const respReset: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', background: 'none', border: 'none',
  color: '#a5b4fc', cursor: 'pointer', padding: 0, fontSize: '.7rem', lineHeight: 1,
};
export const textInput: React.CSSProperties = {
  width: '100%', padding: '0.4rem 0.6rem', background: '#1f1f23', color: '#fafafa',
  border: '1px solid #2a2a30', borderRadius: 6, fontSize: '.85rem', boxSizing: 'border-box',
};
export const textareaInput: React.CSSProperties = {
  ...textInput, fontFamily: 'ui-monospace, "SF Mono", Consolas, monospace',
  lineHeight: 1.5, resize: 'vertical', minHeight: '5.5rem',
};
const selectInput: React.CSSProperties = textInput;
const smallActionBtn: React.CSSProperties = {
  padding: '0.3rem 0.55rem', fontSize: '.75rem', cursor: 'pointer',
  background: '#1f1f23', color: '#d4d4d8', border: '1px solid #3f3f46', borderRadius: 5,
};

function PaletteField({ id, label, value, onChange }: { id: string; label: string; value: string; onChange: (value: unknown) => void }) {
  const [custom, setCustom] = useState(false);
  useEffect(() => { if (value === undefined || value === null || value === '') setCustom(false); }, [value]);
  const named = (COLOR_TOKENS as readonly string[]).includes(value) || !value;
  const isCustom = custom || !named;
  return <>
    <select id={id} aria-label={label} value={isCustom ? '__custom' : value} style={selectInput} onChange={event => {
      const next = event.target.value;
      setCustom(next === '__custom');
      if (next !== '__custom') onChange(next || undefined);
    }}>
      <option value="">Default</option>
      <optgroup label="Site palette">{COLOR_TOKENS.map(token => <option key={token} value={token}>{token.replaceAll('_', ' ')}</option>)}</optgroup>
      <option value="__custom">Custom colour (exception)…</option>
    </select>
    {isCustom && <>
      <input aria-label={`${label} custom colour`} type="text" value={value} placeholder="#ffffff or color-mix(in srgb, var(--color-surface) 92%, var(--color-primary))" style={textInput} onChange={event => onChange(event.target.value)} />
      <p style={fieldHelp}>Exception: a fixed colour does not follow palette changes. Record the reason in decisions.md.</p>
      {value && !validColor(value) && <p role="alert">Unknown colour. Choose a palette name or a valid CSS colour.</p>}
    </>}
  </>;
}
function ScaleField({ id, field, scale, value, onChange }: { id: string; field: FieldDefinition; scale: keyof typeof TOKEN_SCALES; value: unknown; onChange: (value: unknown) => void }) {
  const [custom, setCustom] = useState(false);
  useEffect(() => { if (value === undefined || value === null || value === '') setCustom(false); }, [value]);
  const isCustom = custom || (value !== undefined && value !== null && value !== '' && !scaleValue(scale, value));
  return <>
    <select id={id} aria-label={field.label} style={selectInput} value={isCustom ? '__custom' : String(value ?? '')} onChange={event => {
      const next = event.target.value; setCustom(next === '__custom'); if (next !== '__custom') onChange(next || undefined);
    }}>
      <option value="">Default</option>
      {Object.keys(TOKEN_SCALES[scale]).map(step => <option key={step} value={step}>{step}</option>)}
      <option value="__custom">Custom {scale === 'leading' ? 'line height' : field.label.includes('(em)') ? 'em' : 'pixels'} (exception)…</option>
    </select>
    {isCustom && <>
      <input aria-label={`${field.label} custom value`} type="number" min={field.min} max={field.max} step="any" value={typeof value === 'number' ? value : ''} style={textInput} onChange={event => onChange(event.target.value === '' ? undefined : Number(event.target.value))} />
      <p style={fieldHelp}>Exception: this value does not follow the site scale.</p>
    </>}
  </>;
}
