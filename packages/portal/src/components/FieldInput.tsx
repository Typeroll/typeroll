import { useEffect, useId, useState } from 'react';
import type { Breakpoint, FieldDefinition, ResponsiveBreakpoints } from '@typeroll/shared';
import { BREAKPOINTS, BREAKPOINTS_ABOVE_MOBILE, resolveBreakpointWidths, responsiveBreakpointsError } from '@typeroll/shared';
import { Monitor } from 'lucide-react';
import RichTextInput from './RichTextInput';
import ContentReferenceInput from './ContentReferenceInput';

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
  const label = (
    <label htmlFor={fieldId} style={fieldLabel}>
      {field.label}{field.required && <span aria-hidden="true"> *</span>}
      {responsive && activeBp && (
        <ResponsiveBadge activeBp={activeBp} hasOwn={!!hasOwn} onReset={() => onChange('')} />
      )}
    </label>
  );
  const v = (value ?? '') as string;
  switch (field.type) {
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
          <textarea id={fieldId} aria-label={field.label} aria-required={field.required || undefined}
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
          <select id={fieldId} aria-label={field.label} aria-required={field.required || undefined} value={v} onChange={(e) => onChange(e.target.value)} style={selectInput}>
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
            />
            {field.label}
          </label>
        </div>
      );
    case 'color':
      return (
        <div style={fieldGroup}>
          {label}
          <input id={fieldId} aria-label={field.label} aria-required={field.required || undefined} type="color" value={v || '#000000'} onChange={(e) => onChange(e.target.value)} />
        </div>
      );
    case 'number':
      return (
        <div style={fieldGroup}>
          {label}
          <input id={fieldId} aria-label={field.label} aria-required={field.required || undefined}
            type="number"
            min={field.min}
            max={field.max}
            step="any"
            value={(value as number) ?? ''}
            onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
            style={textInput}
          />
        </div>
      );
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
        <ArrayFieldInput
          siteId={siteId}
          triState={triState}
          field={field}
          value={Array.isArray(value) ? value : []}
          onChange={onChange}
          label={label}
        />
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
          label={label}
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
      return (
        <div style={fieldGroup}>
          {label}
          <input id={fieldId} aria-label={field.label} aria-required={field.required || undefined}
            type={field.type === 'email' ? 'email' : field.type === 'date' ? 'date' : field.type === 'datetime' ? 'datetime-local' : 'text'}
            value={v}
            placeholder={field.placeholder}
            onChange={(e) => onChange(e.target.value)}
            style={textInput}
          />
        </div>
      );
  }
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
  siteId, field, value, onChange, label, triState,
}: {
  siteId?: string;
  field: FieldDefinition;
  value: Record<string, unknown>;
  onChange: (value: unknown) => void;
  label: React.ReactNode;
  triState?: boolean;
}) {
  if (!field.fields?.length) {
    return <JsonFieldInput value={value} onChange={onChange} label={label} expected="object" />;
  }
  return (
    <fieldset style={{ ...fieldGroup, border: '1px solid #2a2a30', borderRadius: 6, padding: 10 }}>
      <legend style={{ padding: '0 4px' }}>{label}</legend>
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

function ArrayFieldInput({
  siteId, field, value, onChange, label, triState,
}: {
  siteId?: string;
  field: FieldDefinition;
  value: unknown[];
  onChange: (value: unknown) => void;
  label: React.ReactNode;
  triState?: boolean;
}) {
  const children = (field.fields ?? []).filter(child => child.name !== field.item_key);
  if (children.length === 0) {
    return <JsonFieldInput value={value} onChange={onChange} label={label} expected="array" />;
  }
  return (
    <fieldset style={{ ...fieldGroup, border: '1px solid #2a2a30', borderRadius: 6, padding: 10 }}>
      <legend style={{ padding: '0 4px' }}>{label}</legend>
      {value.map((raw, index) => {
        const row = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
        return (
          <div key={index} style={{ borderBottom: '1px solid #2a2a30', marginBottom: 10, paddingBottom: 10 }}>
            {children.map((child) => (
              <FieldInput
                key={child.name}
                siteId={siteId}
                triState={triState}
                field={child}
                value={row[child.name]}
                onChange={(next) => {
                  const rows = value.slice();
                  rows[index] = { ...row, [child.name]: next };
                  onChange(rows);
                }}
              />
            ))}
            <button type="button" onClick={() => onChange(value.filter((_, i) => i !== index))} style={smallActionBtn}>
              Remove item
            </button>
          </div>
        );
      })}
      <button type="button" onClick={() => onChange([...value, field.item_key ? { [field.item_key]: crypto.randomUUID() } : {}])} style={smallActionBtn}>+ Add item</button>
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

interface InternalPageOption { id: string; title: string; url: string }
const internalPageRequests = new Map<string, Promise<InternalPageOption[]>>();

function loadInternalPages(siteId: string): Promise<InternalPageOption[]> {
  const existing = internalPageRequests.get(siteId);
  if (existing) return existing;
  const request = fetch(`/api/sites/${encodeURIComponent(siteId)}/pages`)
    .then((response) => response.ok ? response.json() : Promise.reject(new Error('Page lookup failed')))
    .then((payload) => Array.isArray(payload.pages) ? payload.pages as InternalPageOption[] : [])
    .catch((error) => {
      internalPageRequests.delete(siteId);
      throw error;
    });
  internalPageRequests.set(siteId, request);
  return request;
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
