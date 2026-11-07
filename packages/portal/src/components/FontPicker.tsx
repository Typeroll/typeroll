// A font picker for one role: the current family with the site's other roles
// beside it, and a searchable list of the catalog, the site's uploaded fonts,
// its font services, the system font and any other Google Fonts family by
// name. Each result shows sample text in the site's language in that font.
//
// Works inside a plain form: with `name` it keeps a hidden input of that name
// and fires `input` on it when the choice changes.

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { catalogFont, fontSampleText, isSystemFont, type CatalogFont, type FontService, type SiteFontFile, type SiteFontRole } from '@typeroll/shared';
import {
  CATEGORY_LABEL, ROLE_LABEL, describeFontValue, describeWeights, effectiveRoleFamilies, flatOptions, fontPickerSections, moveActive,
  previewFontStack, previewStylesheet, sampleCharacters, type FontOption, type FontPickerFilters, type SiteFonts,
} from './font-picker-model';
import { ensureStylesheet, ensureUploadFaces } from './font-preview';

export interface FontPickerProps {
  siteId: string;
  /** The role this picker sets; decides the in-context sample. */
  role: SiteFontRole;
  label: string;
  /** The current family; empty means unset (see `emptyLabel`). */
  value: string;
  /** Controlled use. Without it the picker keeps its own value. */
  onChange?: (family: string) => void;
  /** Name of a hidden input carrying the value, for plain forms. */
  name?: string;
  /** Offers an unset choice with this label, e.g. "Same as heading". */
  emptyLabel?: string;
  /** The site's fonts, for the other roles beside this one. */
  fonts?: SiteFonts;
  /** The site's language, for the sample text. */
  language?: string;
  /** The site's uploaded fonts (null while loading). */
  uploads?: SiteFontFile[] | null;
  services?: FontService[];
  renderVersion?: number | null;
  disabled?: boolean;
  help?: ReactNode;
}

const CATEGORIES = Object.keys(CATEGORY_LABEL) as CatalogFont['category'][];
const VISIBLE_WITHOUT_OBSERVER = 24;

/** Load whatever a family's preview needs in the portal document. */
export function loadFontPreview(family: string | undefined, context: { siteId: string; uploads?: readonly SiteFontFile[] | null; services?: FontService[]; text: string }) {
  if (!family || isSystemFont(family)) return;
  // A name outside the catalog may be an upload: wait for the library before asking Google.
  if (context.uploads === null && !catalogFont(family) && !context.services?.some(service => service.families.some(name => name.toLowerCase() === family.trim().toLowerCase()))) return;
  if (context.uploads?.some(file => file.family.toLowerCase() === family.trim().toLowerCase())) ensureUploadFaces(context.siteId, context.uploads!);
  else ensureStylesheet(previewStylesheet(family, context));
}

/** The chosen family next to the site's other roles. */
export function RoleContextSample({ role, fonts, language, renderVersion = null }: { role: SiteFontRole; fonts: SiteFonts; language?: string; renderVersion?: number | null }) {
  const sample = fontSampleText(language);
  const families = effectiveRoleFamilies(fonts, renderVersion);
  const line = (lineRole: SiteFontRole, text: string, style: React.CSSProperties = {}) => {
    const family = families[lineRole];
    const option = family ? describeFontValue(family) : undefined;
    return (
      <div className={`fp-sample${lineRole === role ? ' fp-sample--current' : ''}`}>
        <span className="fp-sample__role">{ROLE_LABEL[lineRole]} · {family ? (isSystemFont(family) ? 'system font' : family) : 'system monospace'}</span>
        <span className="fp-sample__text" style={{ fontFamily: lineRole === 'mono' && !family ? 'ui-monospace, monospace' : previewFontStack(family, option?.category), ...style }}>{text}</span>
      </div>
    );
  };
  const heading = line('heading', sample.heading, { fontWeight: 700, fontSize: '1.35rem' });
  const body = line('body', sample.body, { fontSize: '1rem' });
  if (role === 'display') return <div className="fp-context">{line('display', sample.heading, { fontWeight: 700, fontSize: '1.9rem', lineHeight: 1.1 })}{body}</div>;
  if (role === 'accent') return <div className="fp-context">{line('accent', sample.heading.split(' ').slice(0, 3).join(' '), { textTransform: 'uppercase', letterSpacing: '.08em', fontSize: '.85rem', fontWeight: 600 })}{heading}{body}</div>;
  if (role === 'mono') return <div className="fp-context">{body}{line('mono', '0123456789 {} => ÅÄÖ', { fontSize: '.95rem' })}</div>;
  return <div className="fp-context">{heading}{body}</div>;
}

export default function FontPicker({
  siteId, role, label, value, onChange, name, emptyLabel, fonts = {}, language, uploads = null, services = [], renderVersion = null, disabled = false, help,
}: FontPickerProps) {
  const baseId = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const [own, setOwn] = useState(value);
  const current = onChange ? value : own;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState<FontPickerFilters>({});
  const [active, setActive] = useState(-1);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const hidden = useRef<HTMLInputElement>(null);
  const first = useRef(true);
  const text = useMemo(() => sampleCharacters(language), [language]);
  const sample = fontSampleText(language);

  const sections = useMemo(() => fontPickerSections({ query, filters, uploads, services }), [query, filters, uploads, services]);
  const options = useMemo(() => flatOptions(sections), [sections]);
  const option = current ? describeFontValue(current, uploads, services) : null;
  const siteFonts: SiteFonts = { ...fonts, [role]: current || undefined };
  const fallbackRole = role === 'display' ? 'heading' : role === 'accent' ? 'body' : null;

  // Tell the surrounding form (dirty state, live previews) about a new choice.
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    hidden.current?.dispatchEvent(new Event('input', { bubbles: true }));
  }, [current]);

  // The families shown in the in-context sample.
  const contextFamilies = Object.values(effectiveRoleFamilies(siteFonts, renderVersion)).join('|');
  useEffect(() => {
    for (const family of contextFamilies.split('|')) loadFontPreview(family || undefined, { siteId, uploads, services, text });
  }, [contextFamilies, siteId, uploads, services, text]);

  // Load result previews only as they scroll into view.
  useEffect(() => {
    if (!open || !list.current) return;
    const elements = [...list.current.querySelectorAll<HTMLElement>('[data-family]')];
    const context = { siteId, uploads, services, text };
    if (typeof IntersectionObserver === 'undefined') {
      for (const element of elements.slice(0, VISIBLE_WITHOUT_OBSERVER)) loadFontPreview(element.dataset.family, context);
      return;
    }
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) if (entry.isIntersecting) {
        loadFontPreview((entry.target as HTMLElement).dataset.family, context);
        observer.unobserve(entry.target);
      }
    }, { root: list.current, rootMargin: '120px 0px' });
    for (const element of elements) observer.observe(element);
    return () => observer.disconnect();
  }, [open, sections, siteId, uploads, services, text]);

  useEffect(() => { if (open) search.current?.focus(); }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: MouseEvent) => { if (root.current && !root.current.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', outside);
    return () => document.removeEventListener('mousedown', outside);
  }, [open]);
  useEffect(() => {
    if (active >= 0) document.getElementById(`${baseId}-option-${active}`)?.scrollIntoView?.({ block: 'nearest' });
  }, [active, baseId]);

  function choose(family: string) {
    if (onChange) onChange(family); else setOwn(family);
    setOpen(false);
    setQuery('');
    setActive(-1);
    trigger.current?.focus();
  }

  function onSearchKey(event: React.KeyboardEvent<HTMLInputElement>) {
    const next = moveActive(event.key, active, options.length);
    if (next !== null) { event.preventDefault(); setActive(next); return; }
    if (event.key === 'Enter') {
      // Never submit the surrounding form from the search box.
      event.preventDefault();
      const picked = options[active] ?? (options.length === 1 ? options[0] : undefined);
      if (picked) choose(picked.family);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
      trigger.current?.focus();
    }
  }

  const toggle = (key: 'variable' | 'italic' | 'latin_ext') => { setFilters(previous => ({ ...previous, [key]: !previous[key] })); setActive(-1); };
  const currentName = !current ? `${emptyLabel ?? 'Default'}${fallbackRole ? ` (${effectiveRoleFamilies(fonts)[fallbackRole]})` : ''}`
    : isSystemFont(current) ? 'System font' : current;
  let index = -1;

  return (
    <div className="font-picker" ref={root}>
      <style dangerouslySetInnerHTML={{ __html: FONT_PICKER_CSS }} />
      {name && <input ref={hidden} type="hidden" name={name} value={current} />}
      <div className="fp-head">
        <span className="fp-label" id={`${baseId}-label`}>{label}</span>
        <span className="fp-current-name" id={`${baseId}-current`}>{currentName}</span>
        {option && <span className="fp-meta">{describeWeights(option)}</span>}
      </div>
      {help && <div className="fp-help">{help}</div>}
      <RoleContextSample role={role} fonts={siteFonts} language={language} renderVersion={renderVersion} />
      <div className="fp-actions">
        <button ref={trigger} type="button" className="btn btn--secondary btn--sm" disabled={disabled} aria-expanded={open} aria-controls={`${baseId}-panel`}
          aria-describedby={`${baseId}-current`} onClick={() => setOpen(!open)}>
          {open ? 'Close font list' : `Change ${label.toLowerCase()}`}
        </button>
        {emptyLabel && current && !disabled && <button type="button" className="btn btn--ghost btn--sm" onClick={() => choose('')}>{emptyLabel}</button>}
      </div>
      {open && (
        <div className="fp-panel" id={`${baseId}-panel`} role="group" aria-labelledby={`${baseId}-label`}>
          <label className="fp-search-label" htmlFor={`${baseId}-search`}>Search fonts</label>
          <input
            ref={search} id={`${baseId}-search`} className="fp-search" type="search" role="combobox" autoComplete="off" spellCheck={false}
            aria-expanded="true" aria-controls={`${baseId}-listbox`} aria-autocomplete="list"
            aria-activedescendant={active >= 0 ? `${baseId}-option-${active}` : undefined}
            placeholder="Family name, e.g. Lora" value={query}
            onChange={event => { setQuery(event.target.value); setActive(-1); }} onKeyDown={onSearchKey}
            // Searching changes nothing in the surrounding form.
            onInput={event => event.stopPropagation()}
          />
          <div className="fp-filters">
            <div role="group" aria-label="Category" className="fp-chips">
              <button type="button" className="fp-chip" aria-pressed={!filters.category} onClick={() => { setFilters({ ...filters, category: '' }); setActive(-1); }}>All</button>
              {CATEGORIES.map(category => (
                <button key={category} type="button" className="fp-chip" aria-pressed={filters.category === category}
                  onClick={() => { setFilters({ ...filters, category: filters.category === category ? '' : category }); setActive(-1); }}>{CATEGORY_LABEL[category]}</button>
              ))}
            </div>
            <div role="group" aria-label="Features" className="fp-chips">
              <button type="button" className="fp-chip" aria-pressed={!!filters.variable} onClick={() => toggle('variable')}>Variable</button>
              <button type="button" className="fp-chip" aria-pressed={!!filters.italic} onClick={() => toggle('italic')}>Italic</button>
              <button type="button" className="fp-chip" aria-pressed={!!filters.latin_ext} aria-describedby={`${baseId}-latin`} onClick={() => toggle('latin_ext')}>Extended Latin</button>
            </div>
            <p className="fp-hint" id={`${baseId}-latin`}>Every family has Swedish, Norwegian, Danish, Finnish and German letters (å ä ö æ ø ü ß). Extended Latin adds Polish, Czech, Turkish and more.</p>
          </div>
          <div ref={list} className="fp-listbox" id={`${baseId}-listbox`} role="listbox" aria-labelledby={`${baseId}-label`}>
            {sections.length === 0 && <p className="fp-empty">No font matches. Type a Google Fonts family name exactly to use it by name.</p>}
            {sections.map(section => (
              <div key={section.id} role="group" aria-labelledby={`${baseId}-section-${section.id}`} className="fp-section">
                <div role="presentation" id={`${baseId}-section-${section.id}`} className="fp-section__label">{section.label}</div>
                {section.options.map((item: FontOption) => {
                  index += 1;
                  const itemIndex = index;
                  const selected = !!current && current.trim().toLowerCase() === item.family.toLowerCase();
                  return (
                    <div key={`${section.id}:${item.family}`} id={`${baseId}-option-${itemIndex}`} role="option" aria-selected={selected}
                      data-family={item.family} data-active={itemIndex === active || undefined} className="fp-option"
                      onMouseDown={event => event.preventDefault()} onClick={() => choose(item.family)} onMouseEnter={() => setActive(itemIndex)}>
                      <span className="fp-option__name">{item.source === 'custom' ? `Use “${item.family}” from Google Fonts` : item.source === 'system' ? 'System font' : item.family}</span>
                      <span className="fp-option__meta">{describeWeights(item)}</span>
                      <span className="fp-option__sample" style={{ fontFamily: previewFontStack(item.family, item.category) }}>{sample.heading}</span>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
          <p className="fp-hint">
            Not in the list? Type the exact name of any Google Fonts family to use it by name.{' '}
            <a href={`/app/sites/${encodeURIComponent(siteId)}/fonts`}>Upload your own fonts</a> in the Fonts library.
          </p>
        </div>
      )}
    </div>
  );
}

export const FONT_PICKER_CSS = `
.font-picker { display: grid; gap: .5rem; min-width: 0; }
.fp-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: .25rem .6rem; }
.fp-label { font-size: .875rem; font-weight: 600; color: var(--color-text); }
.fp-current-name { font-weight: 500; }
.fp-meta, .fp-hint, .fp-help, .fp-sample__role, .fp-option__meta { font-size: .8rem; color: var(--color-text-muted); }
.fp-hint, .fp-help { margin: 0; }
.fp-context { display: grid; gap: .5rem; padding: .75rem .9rem; border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-bg); min-width: 0; }
.fp-sample { display: grid; gap: 2px; min-width: 0; }
.fp-sample__text { overflow-wrap: anywhere; line-height: 1.35; color: var(--color-text); }
.fp-sample--current .fp-sample__role { color: var(--color-text); font-weight: 600; }
.fp-actions { display: flex; flex-wrap: wrap; gap: .5rem; }
.fp-panel { display: grid; gap: .6rem; padding: .75rem; border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-surface); box-shadow: 0 6px 20px rgba(0,0,0,.08); min-width: 0; }
.fp-search-label { font-size: .8rem; font-weight: 600; }
.fp-search { width: 100%; min-height: 40px; padding: .45rem .6rem; border: 1px solid var(--color-border); border-radius: var(--radius-sm); font: inherit; background: var(--color-surface); color: var(--color-text); }
.fp-filters { display: grid; gap: .4rem; }
.fp-chips { display: flex; flex-wrap: wrap; gap: .35rem; }
.fp-chip { min-height: 32px; padding: .2rem .7rem; border-radius: 999px; border: 1px solid var(--color-border); background: var(--color-surface); color: var(--color-text); font: inherit; font-size: .8rem; cursor: pointer; }
.fp-chip[aria-pressed="true"] { background: var(--color-primary); border-color: var(--color-primary); color: #fff; }
.fp-chip:focus-visible, .fp-search:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 2px; }
.fp-listbox { max-height: 22rem; overflow-y: auto; overscroll-behavior: contain; display: grid; gap: .25rem; border-top: 1px solid var(--color-border); padding-top: .4rem; }
.fp-section { display: grid; gap: 2px; }
.fp-section__label { position: sticky; top: 0; z-index: 1; background: var(--color-surface); font-size: .72rem; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--color-text-muted); padding: .35rem .5rem .2rem; }
.fp-option { display: grid; gap: 1px; padding: .45rem .6rem; border-radius: var(--radius-sm); cursor: pointer; min-width: 0; border: 1px solid transparent; }
.fp-option[data-active] { background: var(--color-bg); border-color: var(--color-border); }
.fp-option[aria-selected="true"] { border-color: var(--color-primary); }
.fp-option__name { font-size: .875rem; font-weight: 600; }
.fp-option__sample { font-size: 1.2rem; line-height: 1.3; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--color-text); }
.fp-empty { margin: .5rem; color: var(--color-text-muted); }
`;
