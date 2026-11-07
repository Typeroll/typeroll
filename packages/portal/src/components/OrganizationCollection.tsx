// The organization collection on a site: templates, sections, page
// templates, global blocks, block types and packages stored once for the
// organization. Search and filter them, insert one into this site's library
// or into a page, save one from this site, import a .typeroll file into it,
// and edit or delete the organization's own entries. Typeroll's built-ins
// are listed read-only. The logic lives in collection-model.ts.

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { CollectionEntryKind } from '@typeroll/shared';
import {
  COLLECTION_KIND_LABELS, COLLECTION_UNAVAILABLE, SOURCE_FILTERS, STYLES_NOTE,
  canInsertIntoPage, collectionApi, entryFieldProblems, entryPatch, filterEntries, groupEntries, insertBody, isEditableEntry,
  knownCategories, libraryActionLabel, publisherOf, renamedStyles, saveBody, saveChoices, sourceLine, summaryLine,
  type CollectionEntryView, type CollectionInsertResult, type EntryFields, type InsertTarget, type SaveChoice, type SourceFilter,
} from './collection-model';
import { ACCEPTED_PACKAGE_FILES, packageApiError, packageFileProblem, reportCounts, reportSections, type PackageApiError } from './package-import-model';
import type { Exportable } from './package-export-model';

interface PageChoice { id: string; title: string; url?: string; content_type?: string }

interface Props {
  siteId: string;
  /** Write access to this site: inserting changes it. */
  canEdit: boolean;
  /** False when the page already knows the collection is not for this person (no request is made). */
  available?: boolean;
  /** Names of the organization's sites, for "Saved from …". */
  siteNames?: Record<string, string>;
  /** Tests start from loaded entries and pages. */
  initial?: { entries: CollectionEntryView[]; pages?: PageChoice[] };
}

type Load = 'loading' | 'ready' | 'unavailable' | 'error';
interface InsertDone { entry: CollectionEntryView; target: InsertTarget; result: CollectionInsertResult; pageTitle?: string }

/** useId without the colons some DOM selectors (datalist lookups) reject. */
const useSafeId = () => useId().replace(/[^a-zA-Z0-9_-]/g, '');
const readJson = async (response: Response) => response.json().catch(() => null) as Promise<Record<string, unknown> | null>;
const failure = (caught: unknown, fallback: string): PackageApiError => ({ message: caught instanceof Error ? caught.message : fallback, details: [] });

export default function OrganizationCollection({ siteId, canEdit, available = true, siteNames = {}, initial }: Props) {
  const api = collectionApi(siteId);
  const domId = useSafeId();
  const [load, setLoad] = useState<Load>(!available ? 'unavailable' : initial ? 'ready' : 'loading');
  const [entries, setEntries] = useState<CollectionEntryView[]>(initial?.entries ?? []);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [source, setSource] = useState<SourceFilter>('all');
  const [kind, setKind] = useState<CollectionEntryKind | 'all'>('all');
  const [error, setError] = useState<PackageApiError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [placing, setPlacing] = useState<string | null>(null);
  const [pages, setPages] = useState<PageChoice[] | null>(initial?.pages ?? null);
  const [done, setDone] = useState<InsertDone | null>(null);
  const [saveOpen, setSaveOpen] = useState(false);
  const [imported, setImported] = useState<{ count: number; warnings: string[] } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (initial || !available) return;
    let live = true;
    fetch(api, { headers: { accept: 'application/json' } }).then(async response => {
      const body = await readJson(response);
      if (!live) return;
      if (response.status === 404 || response.status === 403) { setLoad('unavailable'); return; }
      if (!response.ok || !Array.isArray(body?.entries)) { setLoadError(packageApiError(body, response.status, 'Loading the collection').message); setLoad('error'); return; }
      setEntries(body!.entries as CollectionEntryView[]);
      setLoad('ready');
    }, caught => { if (live) { setLoadError(failure(caught, 'Loading the collection failed.').message); setLoad('error'); } });
    return () => { live = false; };
  }, [api]);

  const shown = useMemo(() => filterEntries(entries, { query, source, kind }), [entries, query, source, kind]);
  const groups = useMemo(() => groupEntries(shown), [shown]);
  const kinds = useMemo(() => groupEntries(entries).map(group => group.kind), [entries]);
  const categories = useMemo(() => knownCategories(entries), [entries]);

  if (load === 'loading') return <p className="muted" role="status">Loading the collection…</p>;
  if (load === 'unavailable') return <div className="card stack"><h2 style={{ margin: 0 }}>The collection is not available</h2><p className="muted" style={{ margin: 0, maxWidth: 640 }}>{COLLECTION_UNAVAILABLE}</p></div>;
  if (load === 'error') return <div className="pk-error" role="alert">{loadError}</div>;

  const replace = (entry: CollectionEntryView) => setEntries(list => list.some(item => item.id === entry.id) ? list.map(item => item.id === entry.id ? entry : item) : [...list, entry]);

  function begin(label: string) { setBusy(label); setError(null); setNotice(null); }

  async function loadPages() {
    if (pages) return;
    try {
      const response = await fetch(`/api/sites/${encodeURIComponent(siteId)}/pages?include_unrouted=true`, { headers: { accept: 'application/json' } });
      const body = await readJson(response);
      if (!response.ok || !Array.isArray(body?.pages)) { setError(packageApiError(body, response.status, 'Loading the pages')); setPages([]); return; }
      setPages(body!.pages as PageChoice[]);
    } catch (caught) { setError(failure(caught, 'Loading the pages failed.')); setPages([]); }
  }

  async function insert(entry: CollectionEntryView, target: InsertTarget) {
    begin(`insert:${entry.id}`);
    setDone(null);
    try {
      const response = await fetch(`${api}/${encodeURIComponent(entry.id)}/insert`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(insertBody(target)) });
      const body = await readJson(response) as CollectionInsertResult | null;
      if (!response.ok || !body?.report) { setError(packageApiError(body, response.status, 'Inserting')); return; }
      const pageTitle = target.target === 'page' ? pages?.find(page => page.id === target.page_id)?.title : undefined;
      setDone({ entry, target, result: body, pageTitle });
      setPlacing(null);
    } catch (caught) { setError(failure(caught, 'Inserting failed.')); }
    finally { setBusy(null); }
  }

  async function saveEdit(entry: CollectionEntryView, fields: EntryFields) {
    const patch = entryPatch(entry, fields);
    if (!Object.keys(patch).length) { setEditing(null); return; }
    begin(`edit:${entry.id}`);
    try {
      const response = await fetch(`${api}/${encodeURIComponent(entry.id)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) });
      const body = await readJson(response);
      if (!response.ok || !body?.entry) { setError(packageApiError(body, response.status, 'Saving')); return; }
      replace(body.entry as CollectionEntryView);
      setEditing(null);
      setNotice('Saved.');
    } catch (caught) { setError(failure(caught, 'Saving failed.')); }
    finally { setBusy(null); }
  }

  async function remove(entry: CollectionEntryView) {
    if (!confirm(`Delete “${entry.name}” from the organization’s collection? Sites that already inserted it keep their copy.`)) return;
    begin(`delete:${entry.id}`);
    try {
      const response = await fetch(`${api}/${encodeURIComponent(entry.id)}`, { method: 'DELETE' });
      const body = await readJson(response);
      if (!response.ok) { setError(packageApiError(body, response.status, 'Deleting')); return; }
      setEntries(list => list.filter(item => item.id !== entry.id));
      if (done?.entry.id === entry.id) setDone(null);
      setNotice(`Deleted “${entry.name}” from the collection.`);
    } catch (caught) { setError(failure(caught, 'Deleting failed.')); }
    finally { setBusy(null); }
  }

  async function importFile(file: File | null) {
    setImported(null);
    const problem = packageFileProblem(file);
    if (problem || !file) { setError({ message: problem ?? 'Choose a .typeroll file.', details: [] }); return; }
    begin('import');
    try {
      const data = new FormData();
      data.set('file', file, file.name);
      const response = await fetch(`${api}/import`, { method: 'POST', body: data });
      const body = await readJson(response);
      if (!response.ok || !Array.isArray(body?.entries)) { setError(packageApiError(body, response.status, 'The import')); return; }
      const added = body!.entries as CollectionEntryView[];
      added.forEach(replace);
      setImported({ count: added.length, warnings: Array.isArray(body!.warnings) ? (body!.warnings as unknown[]).map(String) : [] });
    } catch (caught) { setError(failure(caught, 'The import failed.')); }
    finally { setBusy(null); if (fileRef.current) fileRef.current.value = ''; }
  }

  return (
    <div className="stack col-page">
      <section className="card stack" aria-labelledby={`${domId}-tools`}>
        <h2 id={`${domId}-tools`} className="pk-sr">Find and add entries</h2>
        <div className="col-tools">
          <label className="col-search">
            <span className="pk-sr">Search the collection</span>
            <input type="search" placeholder="Search the collection…" value={query} onChange={event => setQuery(event.target.value)} />
          </label>
          <label className="col-kind">
            <span className="pk-sr">Kind</span>
            <select value={kind} onChange={event => setKind(event.target.value as CollectionEntryKind | 'all')}>
              <option value="all">All kinds</option>
              {kinds.map(item => <option key={item} value={item}>{COLLECTION_KIND_LABELS[item].many}</option>)}
            </select>
          </label>
          <div className="pk-row">
            <button type="button" className="btn btn--secondary" aria-expanded={saveOpen} onClick={() => setSaveOpen(open => !open)}>Save from this site…</button>
            <button type="button" className="btn btn--secondary" disabled={busy === 'import'} onClick={() => fileRef.current?.click()}>{busy === 'import' ? 'Importing…' : 'Import a .typeroll file…'}</button>
            <input ref={fileRef} type="file" accept={ACCEPTED_PACKAGE_FILES} className="pk-sr" tabIndex={-1} aria-label="Import a .typeroll file into the collection" onChange={event => void importFile(event.target.files?.[0] ?? null)} />
          </div>
        </div>
        <div className="col-sources" role="group" aria-label="Source">
          {SOURCE_FILTERS.map(filter => (
            <button key={filter.value} type="button" className="col-chip" aria-pressed={source === filter.value} onClick={() => setSource(filter.value)}>{filter.label}</button>
          ))}
        </div>
        <p className="muted text-sm" style={{ margin: 0 }}>{STYLES_NOTE}</p>
      </section>

      {saveOpen && <SaveFromSite siteId={siteId} api={api} categories={categories} onSaved={entry => { replace(entry); setSaveOpen(false); setNotice(`Saved “${entry.name}” to the collection. Insert it into any of the organization’s sites.`); }} onCancel={() => setSaveOpen(false)} />}

      {error && <div className="pk-error" role="alert">{error.message}{error.details.length > 0 && <ul>{error.details.map((detail, index) => <li key={index}>{detail}</li>)}</ul>}</div>}
      {notice && <p className="pk-notice" role="status">{notice}</p>}
      {imported && <div className="pk-notice stack" role="status">
        <p style={{ margin: 0 }}>{imported.count === 1 ? 'Added 1 entry to the collection.' : `Added ${imported.count} entries to the collection.`}</p>
        {imported.warnings.length > 0 && <div className="pk-warnings" role="note" aria-label="Warnings"><ul>{imported.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></div>}
      </div>}
      {done && <InsertReport siteId={siteId} done={done} onClose={() => setDone(null)} />}

      {entries.length === 0 && <div className="card"><p className="muted" style={{ margin: 0 }}>The collection is empty. Save a template, section, global block or block type from this site, or import a .typeroll file.</p></div>}
      {entries.length > 0 && shown.length === 0 && <p className="muted" role="status">Nothing matches. Try another search or source.</p>}

      {groups.map(group => (
        <section key={group.kind} className="stack col-group" aria-labelledby={`${domId}-${group.kind}`}>
          <h2 id={`${domId}-${group.kind}`} className="col-group__title">{group.label} <span className="muted">({group.count})</span></h2>
          {group.categories.map(category => (
            <div key={category.category ?? ''} className="stack">
              {(category.category || group.categories.length > 1) && <h3 className="col-category">{category.category ?? 'Other'}</h3>}
              <div className="col-grid">
                {category.entries.map(entry => editing === entry.id
                  ? <EntryEditor key={entry.id} entry={entry} categories={categories} busy={busy === `edit:${entry.id}`} onSave={fields => void saveEdit(entry, fields)} onCancel={() => setEditing(null)} />
                  : <EntryCard key={entry.id} entry={entry} siteNames={siteNames} canEdit={canEdit} busy={busy}
                    placing={placing === entry.id} pages={pages}
                    onLibrary={() => void insert(entry, { target: 'library' })}
                    onPlace={() => { setPlacing(placing === entry.id ? null : entry.id); void loadPages(); }}
                    onInsertPage={pageId => void insert(entry, { target: 'page', page_id: pageId })}
                    onEdit={() => setEditing(entry.id)} onDelete={() => void remove(entry)} />)}
              </div>
            </div>
          ))}
        </section>
      ))}
      <style dangerouslySetInnerHTML={{ __html: COLLECTION_CSS }} />
    </div>
  );
}

interface CardProps {
  entry: CollectionEntryView;
  siteNames: Record<string, string>;
  canEdit: boolean;
  busy: string | null;
  placing: boolean;
  pages: PageChoice[] | null;
  onLibrary: () => void;
  onPlace: () => void;
  onInsertPage: (pageId: string) => void;
  onEdit: () => void;
  onDelete: () => void;
}

function EntryCard({ entry, siteNames, canEdit, busy, placing, pages, onLibrary, onPlace, onInsertPage, onEdit, onDelete }: CardProps) {
  const publisher = publisherOf(entry.source);
  const summary = summaryLine(entry.summary);
  const editable = isEditableEntry(entry);
  const inserting = busy === `insert:${entry.id}`;
  return (
    <article className="card col-card" aria-label={entry.name}>
      {entry.preview_url
        ? <img className="col-card__preview" src={entry.preview_url} alt="" loading="lazy" />
        : <div className="col-card__preview col-card__preview--empty" aria-hidden="true">{COLLECTION_KIND_LABELS[entry.kind].one}</div>}
      <h3 className="col-card__title">{entry.name}</h3>
      <p className="col-card__badges">
        <span className="pk-badge" style={{ marginLeft: 0 }}>{COLLECTION_KIND_LABELS[entry.kind].one}</span>
        {!editable && <span className="pk-badge">Read-only</span>}
        {entry.languages?.length ? <span className="pk-badge">{entry.languages.join(', ')}</span> : null}
      </p>
      {entry.description && <p className="text-sm col-card__meta">{entry.description}</p>}
      {summary && <p className="text-sm muted col-card__meta">{summary}</p>}
      <p className="text-sm muted col-card__meta">
        {sourceLine(entry.source, siteNames)}
        {publisher && <> · {publisher.name}{publisher.verified ? <span className="col-verified" title="Verified publisher"> ✓ Verified</span> : <span> (not verified)</span>}</>}
      </p>
      <div className="pk-row col-card__actions">
        {canEdit && <button type="button" className="btn btn--secondary" disabled={Boolean(busy)} onClick={onLibrary}>{inserting && !placing ? 'Adding…' : libraryActionLabel(entry.kind)}</button>}
        {canEdit && canInsertIntoPage(entry) && <button type="button" className="btn btn--secondary" aria-expanded={placing} onClick={onPlace}>Insert into a page…</button>}
        {editable && <button type="button" className="btn btn--secondary" disabled={Boolean(busy)} onClick={onEdit}>Edit</button>}
        {editable && <button type="button" className="btn btn--secondary" disabled={Boolean(busy)} onClick={onDelete}>Delete</button>}
      </div>
      {placing && <PagePicker pages={pages} busy={inserting} onInsert={onInsertPage} />}
    </article>
  );
}

function PagePicker({ pages, busy, onInsert }: { pages: PageChoice[] | null; busy: boolean; onInsert: (pageId: string) => void }) {
  const id = useSafeId();
  const [pageId, setPageId] = useState('');
  if (!pages) return <p className="muted text-sm" role="status" style={{ margin: 0 }}>Loading the pages…</p>;
  if (!pages.length) return <p className="muted text-sm" style={{ margin: 0 }}>This site has no pages yet.</p>;
  return (
    <form className="stack col-place" onSubmit={event => { event.preventDefault(); if (pageId) onInsert(pageId); }}>
      <label htmlFor={id}>Page</label>
      <select id={id} value={pageId} onChange={event => setPageId(event.target.value)}>
        <option value="">Choose a page…</option>
        {pages.map(page => <option key={page.id} value={page.id}>{page.title || page.id}{page.url ? ` — ${page.url}` : ''}</option>)}
      </select>
      <p className="muted text-sm" style={{ margin: 0 }}>Added at the end of the page’s draft. To place it elsewhere, insert it from the block library in the page editor.</p>
      <div><button type="submit" className="btn" disabled={busy || !pageId}>{busy ? 'Inserting…' : 'Insert'}</button></div>
    </form>
  );
}

function EntryEditor({ entry, categories, busy, onSave, onCancel }: { entry: CollectionEntryView; categories: string[]; busy: boolean; onSave: (fields: EntryFields) => void; onCancel: () => void }) {
  const id = useSafeId();
  const [fields, setFields] = useState<EntryFields>({ name: entry.name, description: entry.description ?? '', category: entry.category ?? '' });
  const problems = entryFieldProblems(fields);
  const set = (key: keyof EntryFields) => (event: { target: { value: string } }) => setFields(current => ({ ...current, [key]: event.target.value }));
  return (
    <form className="card stack col-card" aria-label={`Edit ${entry.name}`} onSubmit={event => { event.preventDefault(); if (!Object.keys(problems).length) onSave(fields); }}>
      <label htmlFor={`${id}-name`}>Name</label>
      <input id={`${id}-name`} value={fields.name} onChange={set('name')} required aria-invalid={Boolean(problems.name)} />
      {problems.name && <p className="pk-error">{problems.name}</p>}
      <label htmlFor={`${id}-description`}>Description</label>
      <input id={`${id}-description`} value={fields.description} onChange={set('description')} aria-invalid={Boolean(problems.description)} />
      {problems.description && <p className="pk-error">{problems.description}</p>}
      <label htmlFor={`${id}-category`}>Category</label>
      <input id={`${id}-category`} value={fields.category} onChange={set('category')} list={`${id}-categories`} aria-invalid={Boolean(problems.category)} />
      <datalist id={`${id}-categories`}>{categories.map(category => <option key={category} value={category} />)}</datalist>
      {problems.category && <p className="pk-error">{problems.category}</p>}
      <div className="pk-row">
        <button type="submit" className="btn" disabled={busy || Object.keys(problems).length > 0}>{busy ? 'Saving…' : 'Save'}</button>
        <button type="button" className="btn btn--secondary" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

function SaveFromSite({ siteId, api, categories, onSaved, onCancel }: { siteId: string; api: string; categories: string[]; onSaved: (entry: CollectionEntryView) => void; onCancel: () => void }) {
  const id = useSafeId();
  const [exportable, setExportable] = useState<Exportable | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [key, setKey] = useState('');
  const [fields, setFields] = useState<EntryFields>({ name: '', description: '', category: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<PackageApiError | null>(null);

  useEffect(() => {
    let live = true;
    fetch(`/api/sites/${encodeURIComponent(siteId)}/packages/exportable`, { headers: { accept: 'application/json' } }).then(async response => {
      const body = await readJson(response);
      if (!live) return;
      if (!response.ok || !body) { setLoadError(packageApiError(body, response.status, 'Loading what this site has').message); return; }
      setExportable(body as unknown as Exportable);
    }, caught => { if (live) setLoadError(failure(caught, 'Loading what this site has failed.').message); });
    return () => { live = false; };
  }, [siteId]);

  const choices = saveChoices(exportable);
  const chosen: SaveChoice | undefined = choices.find(choice => choice.key === key);
  const groups = [...new Set(choices.map(choice => choice.group))];
  const problems = entryFieldProblems({ ...fields, name: fields.name || chosen?.label || '' });

  async function submit() {
    if (!chosen) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`${api}/save`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(saveBody(chosen, fields)) });
      const body = await readJson(response);
      if (!response.ok || !body?.entry) { setError(packageApiError(body, response.status, 'Saving to the collection')); return; }
      onSaved(body.entry as CollectionEntryView);
    } catch (caught) { setError(failure(caught, 'Saving to the collection failed.')); }
    finally { setBusy(false); }
  }

  return (
    <section className="card stack" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`} style={{ margin: 0, fontSize: '1.125rem' }}>Save from this site</h2>
      <p className="muted text-sm" style={{ margin: 0 }}>Saves a copy in the organization’s collection with the styles, block types and media it uses. Later changes on this site do not change the saved copy.</p>
      {loadError ? <div className="pk-error" role="alert">{loadError}</div>
        : !exportable ? <p className="muted" role="status">Loading what this site has…</p>
        : !choices.length ? <p className="muted" style={{ margin: 0 }}>This site has no block templates, page templates, global blocks or block types to save yet.</p>
        : <form className="stack" onSubmit={event => { event.preventDefault(); if (chosen && !Object.keys(problems).length) void submit(); }}>
          <label htmlFor={`${id}-what`}>What to save</label>
          <select id={`${id}-what`} value={key} onChange={event => { setKey(event.target.value); const next = choices.find(choice => choice.key === event.target.value); setFields(current => ({ ...current, name: next?.label ?? '', category: current.category || next?.category || '' })); }}>
            <option value="">Choose…</option>
            {groups.map(group => <optgroup key={group} label={group}>{choices.filter(choice => choice.group === group).map(choice => <option key={choice.key} value={choice.key}>{choice.label}</option>)}</optgroup>)}
          </select>
          <label htmlFor={`${id}-name`}>Name in the collection</label>
          <input id={`${id}-name`} value={fields.name} placeholder={chosen?.label} onChange={event => setFields(current => ({ ...current, name: event.target.value }))} />
          {problems.name && fields.name && <p className="pk-error">{problems.name}</p>}
          <label htmlFor={`${id}-category`}>Category <span className="muted">(optional)</span></label>
          <input id={`${id}-category`} value={fields.category} list={`${id}-categories`} placeholder="e.g. Heroes or Pricing" onChange={event => setFields(current => ({ ...current, category: event.target.value }))} />
          <datalist id={`${id}-categories`}>{categories.map(category => <option key={category} value={category} />)}</datalist>
          {problems.category && <p className="pk-error">{problems.category}</p>}
          <label htmlFor={`${id}-description`}>Description <span className="muted">(optional)</span></label>
          <input id={`${id}-description`} value={fields.description} placeholder="When to use it" onChange={event => setFields(current => ({ ...current, description: event.target.value }))} />
          {problems.description && <p className="pk-error">{problems.description}</p>}
          {error && <div className="pk-error" role="alert">{error.message}{error.details.length > 0 && <ul>{error.details.map((detail, index) => <li key={index}>{detail}</li>)}</ul>}</div>}
          <div className="pk-row">
            <button type="submit" className="btn" disabled={busy || !chosen || Object.keys(problems).length > 0}>{busy ? 'Saving…' : 'Save to collection'}</button>
            <button type="button" className="btn btn--secondary" onClick={onCancel}>Cancel</button>
          </div>
        </form>}
    </section>
  );
}

/** What an insert created, reused and renamed, with links into the site. */
export function InsertReport({ siteId, done, onClose }: { siteId: string; done: InsertDone; onClose?: () => void }) {
  const { entry, target, result, pageTitle } = done;
  const report = result.report;
  const sections = reportSections(report, siteId);
  const renamed = renamedStyles(report);
  const pageId = target.target === 'page' ? target.page_id : undefined;
  const pageHref = pageId ? `/app/sites/${encodeURIComponent(siteId)}/pages/${encodeURIComponent(pageId)}` : undefined;
  return (
    <div className="pk-notice stack pk-report" role="status">
      <p style={{ margin: 0 }}><strong>
        {pageHref ? <>Inserted {entry.name} into <a href={pageHref}>{pageTitle ?? (typeof result.page?.title === 'string' ? result.page.title : 'the page')}</a>.</> : <>Added {entry.name} to this site.</>}
      </strong>{pageHref && <> The page’s draft changed; save and publish it from the page editor.</>}</p>
      {sections.length === 0 && <p className="muted" style={{ margin: 0 }}>Nothing new was needed: the site already had everything.</p>}
      {sections.length > 0 && <ul className="pk-report__list">
        {sections.map(section => (
          <li key={section.section}>
            {section.href ? <a href={section.href}><strong>{section.label}</strong></a> : <strong>{section.label}</strong>}
            {' '}<span className="muted text-sm">{reportCounts(section, report)}</span>
            {(section.created.length > 0 || section.renamed.length > 0) && <ul className="pk-report__items">
              {[...section.created, ...section.renamed].slice(0, 30).map((item, index) => <li key={index}>{item.href ? <a href={item.href}>{item.label}</a> : item.label}</li>)}
            </ul>}
          </li>
        ))}
      </ul>}
      {renamed.length > 0 && <p className="text-sm" style={{ margin: 0 }}>
        Renamed styles, because the site already used their ids for something different: {renamed.map(item => `${item.from} → ${item.to}`).join(', ')}.
      </p>}
      {(report.warnings ?? []).length > 0 && <div className="pk-warnings" role="note" aria-label="Warnings"><ul>{report.warnings!.map((warning, index) => <li key={index}>{warning}</li>)}</ul></div>}
      {onClose && <div><button type="button" className="btn btn--secondary" onClick={onClose}>Close</button></div>}
    </div>
  );
}

const COLLECTION_CSS = `
.col-page { max-width: 1100px; min-width: 0; }
.col-tools { display: flex; flex-wrap: wrap; gap: .75rem; align-items: center; }
.col-search { flex: 1 1 16rem; min-width: 0; }
.col-search input, .col-kind select { width: 100%; }
.col-kind { flex: 0 1 12rem; min-width: 0; }
.col-sources { display: flex; flex-wrap: wrap; gap: .4rem; }
.col-chip { padding: .2rem .7rem; border-radius: 999px; border: 1px solid var(--color-border); background: var(--color-surface); color: inherit; font: inherit; font-size: .85rem; cursor: pointer; }
.col-chip[aria-pressed="true"] { border-color: var(--color-primary); background: color-mix(in srgb, var(--color-primary) 10%, var(--color-surface)); font-weight: 600; }
.col-group__title { font-size: 1.125rem; margin: .5rem 0 0; }
.col-category { font-size: .9rem; margin: 0; color: var(--color-text-muted); }
.col-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 16rem), 1fr)); gap: .75rem; }
.col-card { display: grid; gap: .35rem; align-content: start; min-width: 0; }
.col-card__preview { display: block; width: 100%; aspect-ratio: 16 / 9; object-fit: cover; border-radius: 6px; background: var(--color-bg); }
.col-card__preview--empty { display: grid; place-items: center; color: var(--color-text-muted); font-size: .8rem; border: 1px dashed var(--color-border); }
.col-card__title { font-size: 1rem; margin: 0; overflow-wrap: anywhere; }
.col-card__badges { margin: 0; display: flex; flex-wrap: wrap; gap: .3rem; }
.col-card__badges .pk-badge { margin-left: 0; }
.col-card__meta { margin: 0; overflow-wrap: anywhere; }
.col-card__actions { margin-top: .35rem; }
.col-verified { color: var(--color-success); font-weight: 600; }
.col-place { padding-top: .5rem; border-top: 1px solid var(--color-border); }
.col-place select { width: 100%; }
`;
