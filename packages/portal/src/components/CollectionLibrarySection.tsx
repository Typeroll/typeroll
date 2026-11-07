// The organization collection inside the page editor's block library:
// sections, block templates and global blocks to insert into the page. The
// section appears only when the collection loads; the API answers 404 to
// people who may not use it, and the editor then shows nothing.

import { useEffect, useState } from 'react';
import {
  COLLECTION_KIND_LABELS, canInsertIntoPage, collectionApi, collectionPageHref, filterEntries, groupEntries, insertedLine, publisherOf,
  type CollectionEntryView, type CollectionInsertResult, type SaveKind,
} from './collection-model';
import { packageApiError } from './package-import-model';

export interface EditorCollection {
  /** The entries, or null while loading or when the collection is not available. */
  entries: CollectionEntryView[] | null;
  /** Save an existing site item (a block template, global block…) to the collection. */
  save(kind: SaveKind, id: string, fields?: { name?: string; description?: string; category?: string }): Promise<CollectionEntryView>;
  /** Insert an entry into a page; resolves with the insert result. */
  insertIntoPage(entryId: string, pageId: string, afterBlockId?: string | null): Promise<CollectionInsertResult>;
}

/** Load the collection once for the editor; `entries` stays null on 404 or failure. */
export function useEditorCollection(siteId: string): EditorCollection {
  const [entries, setEntries] = useState<CollectionEntryView[] | null>(null);
  const api = collectionApi(siteId);
  useEffect(() => {
    let live = true;
    fetch(api, { headers: { accept: 'application/json' } })
      .then(async response => {
        if (!response.ok) return;
        const body = await response.json().catch(() => null) as { entries?: unknown } | null;
        if (live && Array.isArray(body?.entries)) setEntries(body!.entries as CollectionEntryView[]);
      })
      .catch(() => { /* No collection: the editor shows none. */ });
    return () => { live = false; };
  }, [api]);

  return {
    entries,
    async save(kind, id, fields = {}) {
      const response = await fetch(`${api}/save`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind, id, ...Object.fromEntries(Object.entries(fields).filter(([, value]) => typeof value === 'string' && value.trim()).map(([key, value]) => [key, value!.trim()])) }),
      });
      const body = await response.json().catch(() => null) as { entry?: CollectionEntryView } | null;
      if (!response.ok || !body?.entry) throw new Error(packageApiError(body, response.status, 'Saving to the collection').message);
      const entry = body.entry;
      setEntries(list => list ? [...list.filter(item => item.id !== entry.id), entry] : list);
      return entry;
    },
    async insertIntoPage(entryId, pageId, afterBlockId) {
      const response = await fetch(`${api}/${encodeURIComponent(entryId)}/insert`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ target: 'page', page_id: pageId, ...(afterBlockId ? { after_block_id: afterBlockId } : {}) }),
      });
      const body = await response.json().catch(() => null) as CollectionInsertResult | null;
      if (!response.ok || !body?.report) throw new Error(packageApiError(body, response.status, 'Inserting').message);
      return body;
    },
  };
}

interface SectionProps {
  siteId: string;
  entries: CollectionEntryView[] | null;
  filter: string;
  /** Insert into the page being edited; resolves with the insert result. */
  onInsert: (entry: CollectionEntryView) => Promise<CollectionInsertResult>;
  headingStyle?: React.CSSProperties;
}

/** The block library's Collection section. Renders nothing without entries to place. */
export function CollectionLibrarySection({ siteId, entries, filter, onInsert, headingStyle }: SectionProps) {
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);
  if (!entries) return null;
  const placeable = filterEntries(entries.filter(canInsertIntoPage), { query: filter, source: 'all' });
  if (!placeable.length && !message) return null;

  async function insert(entry: CollectionEntryView) {
    setBusy(entry.id);
    setMessage(null);
    try {
      const result = await onInsert(entry);
      setMessage({ text: insertedLine(entry.name, result.report) });
    } catch (caught) {
      setMessage({ text: caught instanceof Error ? caught.message : 'Inserting failed.', error: true });
    } finally { setBusy(null); }
  }

  return (
    <div style={{ marginTop: '1rem' }}>
      <h4 style={headingStyle}>Collection</h4>
      <p className="block-library__hint">
        From the organization’s collection. Inserts a copy after the selected block, or at the end, and creates the styles it uses on this site (never mapped to the nearest style).
        {' '}<a href={collectionPageHref(siteId)} style={{ color: 'inherit' }}>Open the collection</a>
      </p>
      {message && <p className="block-library__hint" role={message.error ? 'alert' : 'status'} style={message.error ? { color: '#fca5a5' } : undefined}>{message.text}</p>}
      {groupEntries(placeable).map(group => group.categories.map(category => (
        <div key={`${group.kind}:${category.category ?? ''}`} className="block-library__reusable">
          <span className="block-library__category">{group.label}{category.category ? ` · ${category.category}` : ''}</span>
          {category.entries.map(entry => {
            const publisher = publisherOf(entry.source);
            return (
              <button key={entry.id} type="button" className="block-library__item" disabled={Boolean(busy)} onClick={() => void insert(entry)} title={entry.description}>
                {entry.preview_url && <img src={entry.preview_url} alt="" loading="lazy" />}
                <strong>{entry.name}<em className="block-library__kind">{COLLECTION_KIND_LABELS[entry.kind].one}</em></strong>
                {entry.description && <span>{entry.description}</span>}
                {publisher && <span>{publisher.name}{publisher.verified ? ' ✓' : ''}</span>}
                {busy === entry.id && <span>Inserting…</span>}
              </button>
            );
          })}
        </div>
      )))}
    </div>
  );
}
