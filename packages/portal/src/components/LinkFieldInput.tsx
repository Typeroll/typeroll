import { useEffect, useId, useMemo, useState } from 'react';
import { readLinkValue, type LinkValue } from '@typeroll/shared';
import { loadInternalPages, type InternalPageOption } from './internal-pages';

/**
 * A `link` field: a page on this Site (stored by id, so it follows slug
 * changes) or an external address, plus "Open in new tab". Stores
 * `{ page_id }` or `{ url }` (with `new_tab: true` when set), or nothing.
 */
export default function LinkFieldInput({ id, siteId, value, onChange, label }: {
  id?: string;
  siteId?: string;
  value: unknown;
  onChange: (value: LinkValue | undefined) => void;
  label: string;
}) {
  const link = readLinkValue(value);
  const [mode, setMode] = useState<'page' | 'url'>(link.url && !link.page_id ? 'url' : 'page');
  const [pages, setPages] = useState<InternalPageOption[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const fallbackId = useId();
  const inputId = id ?? fallbackId;
  const newTabId = useId();

  useEffect(() => {
    if (!siteId) return;
    let active = true;
    loadInternalPages(siteId)
      .then(list => { if (active) setPages(list); })
      .catch(() => { if (active) { setPages([]); setFailed(true); } });
    return () => { active = false; };
  }, [siteId]);

  const current = link.page_id ? pages?.find(page => page.id === link.page_id) : undefined;
  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (pages ?? []).filter(page => page.url && (!q || `${page.title} ${page.url}`.toLowerCase().includes(q))).slice(0, 8);
  }, [pages, query]);

  const write = (next: LinkValue) => {
    const clean: LinkValue = {};
    if (next.page_id) clean.page_id = next.page_id;
    else if (next.url?.trim()) clean.url = next.url.trim();
    if (next.new_tab && (clean.page_id || clean.url)) clean.new_tab = true;
    onChange(clean.page_id || clean.url ? clean : undefined);
  };

  return (
    <div className="link-input">
      <div className="link-input__modes" role="group" aria-label={`${label}: link to`}>
        <button type="button" aria-pressed={mode === 'page'} onClick={() => setMode('page')}>Page on this Site</button>
        <button type="button" aria-pressed={mode === 'url'} onClick={() => setMode('url')}>Web address</button>
      </div>
      {mode === 'page' ? (
        <div className="link-input__page">
          {link.page_id && !searching ? (
            <div className="link-input__chosen">
              <span>
                <strong>{current?.title ?? (pages ? 'Page not found' : 'Loading…')}</strong>
                {current?.url && <span className="link-input__url">{current.url}</span>}
              </span>
              <button type="button" onClick={() => setSearching(true)} aria-label={`Change the page ${label} links to`}>Change</button>
              <button type="button" onClick={() => write({})} aria-label={`Remove the link from ${label}`}>Remove</button>
            </div>
          ) : (
            <>
              <input id={inputId} type="search" placeholder="Search pages…" value={query} aria-label={`Search pages to link ${label} to`}
                onChange={e => setQuery(e.target.value)} />
              {failed && <p role="alert" className="link-input__note">Could not load pages. Use a web address instead.</p>}
              {pages && !failed && !query.trim() && <p className="link-input__note">Type part of a page title or address.</p>}
              {pages && !failed && query.trim() !== '' && (
                <ul className="link-input__results" aria-label="Pages">
                  {results.map(page => (
                    <li key={page.id}>
                      <button type="button" onClick={() => { write({ page_id: page.id, new_tab: link.new_tab }); setSearching(false); setQuery(''); }}>
                        <strong>{page.title || page.url}</strong> <span className="link-input__url">{page.url}</span>
                      </button>
                    </li>
                  ))}
                  {!results.length && <li className="link-input__note">No pages match.</li>}
                </ul>
              )}
              {searching && <button type="button" className="link-input__cancel" onClick={() => setSearching(false)}>Keep the current page</button>}
            </>
          )}
        </div>
      ) : (
        <input id={inputId} type="text" inputMode="url" placeholder="https://example.com or mailto:…" value={link.page_id ? '' : link.url ?? ''}
          aria-label={id ? undefined : `${label} address`}
          onChange={e => write({ url: e.target.value, new_tab: link.new_tab })} />
      )}
      <label htmlFor={newTabId} className="link-input__tab">
        <input id={newTabId} type="checkbox" checked={link.new_tab === true} disabled={!link.page_id && !link.url}
          onChange={e => write({ ...link, new_tab: e.target.checked })} />
        Open in new tab
      </label>
      <style>{LINK_INPUT_CSS}</style>
    </div>
  );
}

const LINK_INPUT_CSS = `
.link-input { display: grid; gap: 6px; min-width: 0; font-size: .85rem; }
.link-input input[type="search"], .link-input input[type="text"] { width: 100%; padding: .4rem .6rem; border-radius: 6px; background: #1f1f23; color: #fafafa; border: 1px solid #3a3a42; font-size: .85rem; }
.link-input__modes { display: grid; grid-template-columns: 1fr 1fr; border: 1px solid #3f3f46; border-radius: 6px; overflow: hidden; }
.link-input__modes button { padding: .35rem .5rem; border: 0; background: #1f1f23; color: #d4d4d8; cursor: pointer; font-size: .8rem; }
.link-input__modes button[aria-pressed="true"] { background: #3730a3; color: #fff; }
.link-input button:focus-visible { outline: 2px solid #818cf8; outline-offset: 1px; }
.link-input__chosen { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 6px 8px; border: 1px solid #3a3a42; border-radius: 6px; background: #18181b; }
.link-input__chosen > span { flex: 1; min-width: 0; display: grid; overflow-wrap: anywhere; color: #fafafa; }
.link-input__chosen button, .link-input__cancel { padding: .25rem .5rem; font-size: .75rem; border-radius: 5px; cursor: pointer; background: #27272a; color: #f4f4f5; border: 1px solid #52525b; }
.link-input__cancel { justify-self: start; }
.link-input__url { font-size: .75rem; color: #d4d4d8; font-weight: 400; }
.link-input__results { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; max-height: 200px; overflow-y: auto; }
.link-input__results button { width: 100%; text-align: left; display: grid; gap: 1px; padding: .35rem .5rem; border-radius: 5px; border: 1px solid transparent; background: #18181b; color: #fafafa; cursor: pointer; }
.link-input__results button:hover { border-color: #818cf8; }
.link-input__note { color: #d4d4d8; font-size: .8rem; margin: 0; padding: .25rem .5rem; }
.link-input__tab { display: flex; gap: 8px; align-items: center; color: #e4e4e7; font-size: .8rem; }
`;
