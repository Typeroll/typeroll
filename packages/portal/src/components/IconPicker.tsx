import { useId, useMemo, useState } from 'react';
import { CORE_ICON_NAMES, renderIconHtml } from '@typeroll/shared';

/**
 * A searchable grid of the core icons for `icon` fields. The stored value is
 * the icon name; a value that is not a core icon (an emoji, older content)
 * is shown as is and kept until another icon is chosen.
 */
export default function IconPicker({ id, value, onChange, label }: {
  id?: string;
  value: string;
  onChange: (value: string | undefined) => void;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const panelId = useId();
  const known = CORE_ICON_NAMES.includes(value);
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase().replace(/\s+/g, '-');
    return q ? CORE_ICON_NAMES.filter(name => name.includes(q)) : CORE_ICON_NAMES;
  }, [query]);

  return (
    <div className="icon-picker">
      <div className="icon-picker__current">
        <span className="icon-picker__swatch" aria-hidden="true"
          // Core icons are static SVG from the shared set; other values are escaped by renderIconHtml.
          dangerouslySetInnerHTML={{ __html: value ? renderIconHtml(value) : '' }} />
        <span className="icon-picker__name">{value ? (known ? value : `${value} (not a core icon)`) : 'No icon'}</span>
        <button id={id} type="button" className="icon-picker__btn" aria-expanded={open} aria-controls={panelId}
          aria-label={`${open ? 'Close' : 'Choose'} icon for ${label}`} onClick={() => setOpen(o => !o)}>
          {open ? 'Close' : 'Choose icon'}
        </button>
        {value && <button type="button" className="icon-picker__btn" aria-label={`Remove icon from ${label}`} onClick={() => onChange(undefined)}>Remove</button>}
      </div>
      {open && (
        <div id={panelId} className="icon-picker__panel">
          <input type="search" className="icon-picker__search" aria-label={`Search icons for ${label}`} placeholder="Search icons…"
            value={query} autoFocus onChange={e => setQuery(e.target.value)} />
          <p className="icon-picker__count" aria-live="polite">{matches.length} {matches.length === 1 ? 'icon' : 'icons'}</p>
          <div className="icon-picker__grid" role="group" aria-label="Icons">
            {matches.map(name => (
              <button key={name} type="button" className="icon-picker__icon" title={name} aria-label={name} aria-pressed={name === value}
                onClick={() => { onChange(name); setOpen(false); setQuery(''); }}
                dangerouslySetInnerHTML={{ __html: renderIconHtml(name) }} />
            ))}
          </div>
        </div>
      )}
      <style>{ICON_PICKER_CSS}</style>
    </div>
  );
}

const ICON_PICKER_CSS = `
.icon-picker { display: grid; gap: 6px; min-width: 0; }
.icon-picker__current { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; min-width: 0; }
.icon-picker__swatch { display: inline-grid; place-items: center; width: 32px; height: 32px; border-radius: 6px; background: #27272a; color: #fafafa; font-size: 20px; border: 1px solid #3f3f46; }
.icon-picker__swatch svg { width: 20px; height: 20px; }
.icon-picker__name { font-size: .85rem; color: #e4e4e7; flex: 1 1 5rem; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.icon-picker__btn { padding: .3rem .6rem; font-size: .8rem; border-radius: 5px; cursor: pointer; background: #27272a; color: #f4f4f5; border: 1px solid #52525b; }
.icon-picker__btn:focus-visible, .icon-picker__icon:focus-visible { outline: 2px solid #818cf8; outline-offset: 2px; }
.icon-picker__panel { display: grid; gap: 6px; padding: 8px; border: 1px solid #3a3a42; border-radius: 8px; background: #18181b; }
.icon-picker__search { width: 100%; padding: .4rem .6rem; border-radius: 6px; background: #1f1f23; color: #fafafa; border: 1px solid #3a3a42; font-size: .85rem; }
.icon-picker__count { margin: 0; font-size: .75rem; color: #d4d4d8; }
.icon-picker__grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(36px, 1fr)); gap: 4px; max-height: 220px; overflow-y: auto; }
.icon-picker__icon { display: grid; place-items: center; aspect-ratio: 1; min-height: 36px; padding: 0; border-radius: 6px; cursor: pointer; background: #27272a; color: #fafafa; border: 1px solid #3f3f46; font-size: 18px; }
.icon-picker__icon svg { width: 18px; height: 18px; }
.icon-picker__icon:hover { border-color: #a5b4fc; }
.icon-picker__icon[aria-pressed="true"] { background: #312e81; border-color: #a5b4fc; }
`;
