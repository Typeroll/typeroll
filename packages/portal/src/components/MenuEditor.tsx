import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ArrowDown, ArrowUp, GripVertical, IndentDecrease, IndentIncrease, Pencil, Trash2 } from 'lucide-react';
import {
  MAX_MENU_DEPTH, MAX_MENU_ITEMS, MENU_LOCATIONS, resolveMenu,
  type Menu, type MenuItem, type MenuItemType, type MenuPage, type MenuValidationError, type ResolvedMenuItem,
} from '@typeroll/shared';
import HistoryPanel from './HistoryPanel';
import IconPicker from './IconPicker';
import type { BlockUsage } from '../lib/block-usage-summary';
import {
  addItem, canAddTo, canIndent, canMove, canOutdent, countItems, errorsByItem, findItem, flattenItems, hrefProblem,
  indentItem, moveItem, moveToIndex, nextItemId, normalizeLocation, outdentItem, removeItem, updateItem,
} from './menu-tree';

/** A routed page of the site, as the menu editor needs it. */
export type MenuEditorPage = MenuPage;

interface Props {
  siteId: string;
  menu: Menu;
  pages: MenuEditorPage[];
  /** Locations other menus fill → that menu's name. */
  takenLocations: Record<string, string>;
  canEdit: boolean;
}

interface Draft { name: string; locations: string[]; auto_add_pages: boolean; items: MenuItem[] }
type SaveState = 'idle' | 'saving' | 'saved' | 'error';
interface Problem { kind: 'stale' | 'location' | 'error'; message: string }
interface UsageResponse extends BlockUsage { menu_id: string; locations: string[] }

const TYPE_LABELS: Record<MenuItemType, string> = { page: 'Page', url: 'Link', children: "Page's children", heading: 'Heading' };
const LOCATION_LABELS: Record<string, string> = { primary: 'Primary', footer: 'Footer', mobile: 'Mobile' };

const toDraft = (menu: Menu): Draft => ({
  name: menu.name, locations: menu.locations ?? [], auto_add_pages: menu.auto_add_pages === true, items: menu.items ?? [],
});

/**
 * The body of a PUT: the whole menu plus the updated_at it was read at. A
 * chosen location another menu fills (`takenLocations`) is moved to this
 * menu: the save sends `take_locations`, and the other menu keeps its items.
 */
export function menuSaveBody(draft: Draft, expectedUpdatedAt: string, takenLocations: Record<string, string> = {}): Record<string, unknown> {
  return {
    name: draft.name.trim(),
    locations: draft.locations,
    auto_add_pages: draft.auto_add_pages,
    items: draft.items,
    expected_updated_at: expectedUpdatedAt,
    ...(draft.locations.some((location) => Object.hasOwn(takenLocations, location)) ? { take_locations: true } : {}),
  };
}

/** The label of a location another menu fills, as the location pickers show it. */
export function takenLocationNote(menuName: string, chosen: boolean): string {
  return chosen ? ` Used by “${menuName}”; will move to this menu when you save` : ` Used by “${menuName}”; choosing it moves it here`;
}

/** A 409 from the menu routes: someone else saved, or a location is taken. */
export function conflictKind(message: string): 'stale' | 'location' {
  return /\blocation\b/i.test(message) && !/saved by someone else/i.test(message) ? 'location' : 'stale';
}

export default function MenuEditor({ siteId, menu, pages, takenLocations: initialTaken, canEdit }: Props) {
  // Locations other menus fill; a save that moves one here drops it.
  const [takenLocations, setTakenLocations] = useState(initialTaken);
  const menuUrl = `/api/sites/${encodeURIComponent(siteId)}/menus/${encodeURIComponent(menu.id)}`;
  const [draft, setDraft] = useState<Draft>(() => toDraft(menu));
  const [baseline, setBaseline] = useState(() => JSON.stringify(toDraft(menu)));
  const [updatedAt, setUpdatedAt] = useState(menu.updated_at ?? '');
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [problem, setProblem] = useState<Problem | null>(null);
  const [itemErrors, setItemErrors] = useState<Map<string, string[]>>(new Map());
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [tab, setTab] = useState<'menu' | 'history'>('menu');
  const [removed, setRemoved] = useState<{ items: MenuItem[]; label: string } | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [usage, setUsage] = useState<UsageResponse | null>(null);
  const [usageError, setUsageError] = useState<string | null>(null);
  const pendingFocus = useRef<string | null>(null);
  const leaving = useRef(false);
  const domId = useId().replace(/[^a-zA-Z0-9_-]/g, '');

  const dirty = JSON.stringify(draft) !== baseline;
  const pagesById = useMemo(() => new Map(pages.map((page) => [page.id, page])), [pages]);
  const total = countItems(draft.items);
  const atLimit = total >= MAX_MENU_ITEMS;

  useEffect(() => {
    if (!dirty) return;
    const guard = (event: BeforeUnloadEvent) => { if (leaving.current) return; event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [dirty]);

  useEffect(() => {
    if (!pendingFocus.current) return;
    document.getElementById(pendingFocus.current)?.focus();
    pendingFocus.current = null;
  });

  useEffect(() => {
    let cancelled = false;
    fetch(`${menuUrl}/usage`)
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (cancelled) return;
        if (!response.ok) setUsageError(body.error ?? `Lookup failed (${response.status})`);
        else setUsage({ ...body, pages: body.pages ?? [], templates: body.templates ?? [], global_blocks: body.global_blocks ?? [] });
      })
      .catch((error) => { if (!cancelled) setUsageError(error instanceof Error ? error.message : 'Lookup failed'); });
    return () => { cancelled = true; };
  }, [menuUrl, updatedAt]);

  const ctrlId = (id: string, control: string) => `${domId}-${id}-${control}`;
  const labelOf = (item: MenuItem): string => {
    if (item.label) return item.label;
    if (item.type === 'page') return pagesById.get(item.page_id ?? '')?.title ?? 'Missing page';
    if (item.type === 'children') return `Children of ${pagesById.get(item.page_id ?? '')?.title ?? 'a missing page'}`;
    if (item.type === 'url') return item.href || 'Link';
    return 'Heading';
  };

  function setItems(items: MenuItem[], message?: string) {
    setDraft((current) => ({ ...current, items }));
    if (message) setAnnouncement(message);
  }

  function move(item: MenuItem, delta: -1 | 1) {
    const next = moveItem(draft.items, item.id, delta);
    const at = findItem(next, item.id)!;
    setItems(next, `${labelOf(item)} moved to position ${at.index + 1} of ${at.siblings.length}.`);
    const control = delta < 0 ? 'up' : 'down';
    pendingFocus.current = canMove(next, item.id, delta) ? ctrlId(item.id, control) : ctrlId(item.id, 'edit');
  }

  function indent(item: MenuItem) {
    const next = indentItem(draft.items, item.id);
    const at = findItem(next, item.id)!;
    setItems(next, `${labelOf(item)} is now under ${labelOf(findItem(next, at.parentId!)!.item)}.`);
    pendingFocus.current = canIndent(next, item.id) ? ctrlId(item.id, 'indent') : ctrlId(item.id, 'outdent');
  }

  function outdent(item: MenuItem) {
    const next = outdentItem(draft.items, item.id);
    const at = findItem(next, item.id)!;
    setItems(next, `${labelOf(item)} moved up to level ${at.depth}.`);
    pendingFocus.current = canOutdent(next, item.id) ? ctrlId(item.id, 'outdent') : ctrlId(item.id, 'indent');
  }

  function remove(item: MenuItem) {
    const label = labelOf(item);
    setRemoved({ items: draft.items, label });
    setItems(removeItem(draft.items, item.id), `${label} removed.`);
  }

  function undoRemove() {
    if (!removed) return;
    setItems(removed.items, `${removed.label} restored.`);
    setRemoved(null);
  }

  function add(item: Omit<MenuItem, 'id'>, parentId: string | null) {
    if (atLimit) return;
    const id = nextItemId(draft.items);
    const full = { ...item, id } as MenuItem;
    setItems(addItem(draft.items, full, parentId), `${labelOf(full)} added.`);
    setRemoved(null);
  }

  function toggle(id: string) {
    setOpen((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  }

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  function onDragEnd(event: DragEndEvent) {
    if (!event.over || event.active.id === event.over.id) return;
    const from = findItem(draft.items, String(event.active.id));
    const to = findItem(draft.items, String(event.over.id));
    // Drag reorders among siblings; indent and outdent change the level.
    if (!from || !to || from.parentId !== to.parentId) return;
    setItems(moveToIndex(draft.items, from.item.id, to.index), `${labelOf(from.item)} moved to position ${to.index + 1} of ${from.siblings.length}.`);
  }

  async function save() {
    if (!canEdit) return;
    setSaveState('saving');
    setProblem(null);
    try {
      const response = await fetch(menuUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(menuSaveBody(draft, updatedAt, takenLocations)),
      });
      const body = await response.json().catch(() => ({})) as { menu?: Menu; moved_locations?: Array<{ location: string; from_menu_id: string }>; error?: string; errors?: MenuValidationError[] };
      if (!response.ok) {
        const message = body.error ?? `Save failed (${response.status})`;
        setItemErrors(body.errors?.length ? errorsByItem(draft.items, body.errors) : new Map());
        if (body.errors?.length) {
          // Open the items with problems so their messages and fields show.
          const ids = [...errorsByItem(draft.items, body.errors).keys()].filter(Boolean);
          setOpen((current) => new Set([...current, ...ids]));
        }
        const taken = response.status === 409 ? /location "([^"]+)" is already filled by the menu "([^"]*)"/.exec(message) : null;
        // Another menu took the location after this page loaded: the next save moves it.
        if (taken) setTakenLocations((current) => ({ ...current, [taken[1]!]: taken[2]! }));
        setProblem(taken ? { kind: 'location', message: `The location ${LOCATION_LABELS[taken[1]!] ?? taken[1]} is used by “${taken[2]}”.` }
          : response.status === 409 ? { kind: conflictKind(message), message } : { kind: 'error', message: body.errors?.length ? 'The menu was not saved. Fix the problems marked below.' : message });
        setSaveState('error');
        return;
      }
      const saved = body.menu!;
      const next = toDraft(saved);
      setDraft(next);
      setBaseline(JSON.stringify(next));
      setUpdatedAt(saved.updated_at ?? '');
      setItemErrors(new Map());
      const moved = body.moved_locations ?? [];
      if (moved.length) {
        const names = moved.map(({ location }) => `${LOCATION_LABELS[location] ?? location} (from “${takenLocations[location] ?? location}”)`);
        setTakenLocations((current) => Object.fromEntries(Object.entries(current).filter(([location]) => !moved.some((entry) => entry.location === location))));
        setAnnouncement(`Menu saved. Moved to this menu: ${names.join(', ')}.`);
      } else setAnnouncement('Menu saved.');
      setSaveState('saved');
      window.setTimeout(() => setSaveState((state) => (state === 'saved' ? 'idle' : state)), 1500);
    } catch (error) {
      setProblem({ kind: 'error', message: error instanceof Error ? error.message : 'Save failed' });
      setSaveState('error');
    }
  }

  async function reloadFromServer() {
    setProblem(null);
    const response = await fetch(menuUrl);
    const body = await response.json().catch(() => ({})) as { menu?: Menu; error?: string };
    if (!response.ok || !body.menu) { setProblem({ kind: 'error', message: body.error ?? 'Could not load the menu' }); return; }
    const next = toDraft(body.menu);
    setDraft(next);
    setBaseline(JSON.stringify(next));
    setUpdatedAt(body.menu.updated_at ?? '');
    setItemErrors(new Map());
    setRemoved(null);
    setAnnouncement('Loaded the saved menu.');
  }

  async function deleteMenu() {
    setDeleting(true);
    setProblem(null);
    try {
      const response = await fetch(menuUrl, { method: 'DELETE' });
      const body = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? `Delete failed (${response.status})`);
      leaving.current = true; // the menu is gone: nothing left to guard
      window.location.href = `/app/sites/${encodeURIComponent(siteId)}/menus`;
    } catch (error) {
      setProblem({ kind: 'error', message: error instanceof Error ? error.message : 'Delete failed' });
      setDeleting(false);
    }
  }

  const preview = useMemo(
    () => resolveMenu({ id: menu.id, name: draft.name || menu.id, items: draft.items, auto_add_pages: draft.auto_add_pages }, pages, ''),
    [draft.items, draft.auto_add_pages, draft.name, pages, menu.id],
  );
  const menuErrors = itemErrors.get('') ?? [];
  const nameError = menuErrors.find((message) => message.startsWith('name:'));
  const usageCount = usage ? usage.pages.length + usage.templates.length + usage.global_blocks.length : 0;
  const reference = draft.locations[0] ? `location:${draft.locations[0]}` : menu.id;

  const renderList = (items: MenuItem[], depth: number) => (
    <SortableContext items={items.map((item) => item.id)} strategy={verticalListSortingStrategy}>
      <ol className={`menu-editor__list${depth > 1 ? ' menu-editor__list--nested' : ''}`} aria-label={depth === 1 ? 'Menu items' : undefined}>
        {items.map((item, index) => {
          const label = labelOf(item);
          const errors = itemErrors.get(item.id) ?? [];
          const page = item.page_id ? pagesById.get(item.page_id) : undefined;
          const detail = item.type === 'url' ? item.href : item.type === 'heading' ? 'No link' : page ? page.path : 'The page no longer exists';
          return (
            <MenuRow key={item.id} id={item.id} label={label} disabled={!canEdit}>
              {(handle) => (
                <>
                  <div className={`menu-editor__row${errors.length ? ' menu-editor__row--error' : ''}`}>
                    {canEdit && handle}
                    <div className="menu-editor__row-text">
                      <span className="menu-editor__sr">{`Level ${depth}, ${index + 1} of ${items.length}: `}</span>
                      <span className="menu-editor__row-label">{label}</span>
                      <span className={`menu-editor__badge menu-editor__badge--${item.type}`}>{TYPE_LABELS[item.type]}</span>
                      {page && page.status && page.status !== 'published' && <span className="menu-editor__badge menu-editor__badge--warn">{`${page.status}: hidden until published`}</span>}
                      {detail && <span className="menu-editor__row-detail">{detail}</span>}
                    </div>
                    {canEdit && (
                      <span className="menu-editor__actions">
                        <button id={ctrlId(item.id, 'edit')} type="button" aria-expanded={open.has(item.id)} aria-controls={ctrlId(item.id, 'panel')}
                          aria-label={`Edit ${label}`} title="Edit" onClick={() => toggle(item.id)}><Pencil size={15} aria-hidden="true" /></button>
                        <button id={ctrlId(item.id, 'up')} type="button" aria-label={`Move ${label} up`} title="Move up"
                          disabled={!canMove(draft.items, item.id, -1)} onClick={() => move(item, -1)}><ArrowUp size={15} aria-hidden="true" /></button>
                        <button id={ctrlId(item.id, 'down')} type="button" aria-label={`Move ${label} down`} title="Move down"
                          disabled={!canMove(draft.items, item.id, 1)} onClick={() => move(item, 1)}><ArrowDown size={15} aria-hidden="true" /></button>
                        <button id={ctrlId(item.id, 'outdent')} type="button" aria-label={`Move ${label} out one level`} title="Move out one level"
                          disabled={!canOutdent(draft.items, item.id)} onClick={() => outdent(item)}><IndentDecrease size={15} aria-hidden="true" /></button>
                        <button id={ctrlId(item.id, 'indent')} type="button" aria-label={`Move ${label} under the item above`} title={`Move under the item above (at most ${MAX_MENU_DEPTH} levels)`}
                          disabled={!canIndent(draft.items, item.id)} onClick={() => indent(item)}><IndentIncrease size={15} aria-hidden="true" /></button>
                        <button type="button" aria-label={`Remove ${label}`} title="Remove" onClick={() => remove(item)}><Trash2 size={15} aria-hidden="true" /></button>
                      </span>
                    )}
                  </div>
                  {errors.length > 0 && <ul className="menu-editor__errors" role="alert">{errors.map((message) => <li key={message}>{message}</li>)}</ul>}
                  {open.has(item.id) && canEdit && (
                    <ItemFields id={ctrlId(item.id, 'panel')} item={item} pages={pages} pagesById={pagesById} label={label}
                      onChange={(patch) => setItems(updateItem(draft.items, item.id, patch))} onDone={() => { toggle(item.id); pendingFocus.current = ctrlId(item.id, 'edit'); }} />
                  )}
                  {item.children?.length ? renderList(item.children, depth + 1) : null}
                </>
              )}
            </MenuRow>
          );
        })}
      </ol>
    </SortableContext>
  );

  return (
    <div className="menu-editor">
      <div className="menu-editor__bar card">
        <span className="menu-editor__status" role="status">
          {saveState === 'saving' ? 'Saving…' : saveState === 'saved' ? 'Saved' : dirty ? 'Unsaved changes' : 'All changes saved'}
        </span>
        {canEdit && <button type="button" className="btn" onClick={save} disabled={saveState === 'saving' || (!dirty && !problem)}>Save menu</button>}
      </div>

      {problem && (
        <div className={`menu-editor__problem menu-editor__problem--${problem.kind}`} role="alert">
          <p>{problem.message}</p>
          {problem.kind === 'stale' && (
            <p className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <button type="button" className="btn btn--secondary btn--sm" onClick={reloadFromServer}>Load the saved menu (drops your changes)</button>
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => setProblem(null)}>Keep editing</button>
            </p>
          )}
          {problem.kind === 'location' && <p className="text-sm">Save again to move that location to this menu (the other menu keeps its items), or untick it here.</p>}
        </div>
      )}
      {!canEdit && <p className="muted text-sm">You can view this menu. Editing needs write access to the site.</p>}

      <div className="tabs" role="tablist" aria-label="Menu editor">
        <button type="button" role="tab" aria-selected={tab === 'menu'} className={tab === 'menu' ? 'is-active' : ''} onClick={() => setTab('menu')}>Menu</button>
        <button type="button" role="tab" aria-selected={tab === 'history'} className={tab === 'history' ? 'is-active' : ''} onClick={() => setTab('history')}>History</button>
      </div>

      {tab === 'history' ? (
        <div className="card">
          {dirty && <p className="muted text-sm" style={{ marginBottom: 8 }}>Restoring reloads the page; save or drop your changes first.</p>}
          <HistoryPanel endpoint={`${menuUrl}/revisions`} />
        </div>
      ) : (
        <div className="menu-editor__grid">
          <div className="menu-editor__main">
            <section className="card stack-sm" aria-labelledby={`${domId}-settings`}>
              <h2 id={`${domId}-settings`} className="menu-editor__h">Settings</h2>
              <div className="field">
                <label htmlFor={`${domId}-name`}>Name</label>
                <input id={`${domId}-name`} value={draft.name} maxLength={120} disabled={!canEdit} aria-invalid={!!nameError || !draft.name.trim()}
                  onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
                {nameError && <span className="menu-editor__field-error">{nameError.replace(/^name: /, '')}</span>}
              </div>
              <LocationsField locations={draft.locations} takenLocations={takenLocations} disabled={!canEdit}
                onChange={(locations) => setDraft({ ...draft, locations })} />
              <label className="menu-editor__check">
                <input type="checkbox" checked={draft.auto_add_pages} disabled={!canEdit}
                  onChange={(event) => setDraft({ ...draft, auto_add_pages: event.target.checked })} />
                <span>
                  <strong>Add new top-level pages automatically</strong>
                  <span className="muted text-sm"> Published pages without a parent that the menu does not link yet are added at the end, in page order. The home page is left out.</span>
                </span>
              </label>
              {menuErrors.filter((message) => message !== nameError).map((message) => <p key={message} className="menu-editor__field-error">{message}</p>)}
            </section>

            <section className="card" aria-labelledby={`${domId}-items`}>
              <div className="menu-editor__section-head">
                <h2 id={`${domId}-items`} className="menu-editor__h">Items</h2>
                <span className="muted text-sm">{total} of at most {MAX_MENU_ITEMS} · up to {MAX_MENU_DEPTH} levels</span>
              </div>
              {draft.items.length === 0 ? (
                <p className="muted menu-editor__empty">No items yet. Add pages, links or headings from the panel{canEdit ? '' : ' (needs write access)'}.</p>
              ) : (
                <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
                  {renderList(draft.items, 1)}
                </DndContext>
              )}
              {removed && (
                <div className="menu-editor__undo" role="status">
                  <span>Removed “{removed.label}”.</span>
                  <button type="button" className="btn btn--ghost btn--sm" onClick={undoRemove}>Undo</button>
                </div>
              )}
              <p className="menu-editor__sr" aria-live="polite">{announcement}</p>
            </section>
          </div>

          <aside className="menu-editor__side">
            {canEdit && <AddPanel items={draft.items} pages={pages} labelOf={labelOf} atLimit={atLimit} onAdd={add} />}

            <section className="card stack-sm" aria-labelledby={`${domId}-preview`}>
              <h2 id={`${domId}-preview`} className="menu-editor__h">Preview</h2>
              <p className="muted text-sm">What visitors get once published: unpublished pages are left out, page items show the page's current title.</p>
              {preview.items.length ? <PreviewList items={preview.items} /> : <p className="muted text-sm">The menu shows nothing yet.</p>}
              {preview.warnings.length > 0 && (
                <ul className="menu-editor__warnings">
                  {preview.warnings.map((warning) => <li key={warning}>{warning.replace(/^Menu "[^"]*": /, '')}</li>)}
                </ul>
              )}
            </section>

            <section className="card stack-sm" aria-labelledby={`${domId}-usage`}>
              <h2 id={`${domId}-usage`} className="menu-editor__h">Where it shows</h2>
              {usageError ? <p className="menu-editor__field-error">Couldn't load usage: {usageError}</p>
                : !usage ? <p className="muted text-sm">Looking for blocks that show this menu…</p>
                : usageCount === 0 ? <p className="muted text-sm">No page, template or global block shows this menu yet.</p>
                : (
                  <ul className="menu-editor__usage">
                    {usage.global_blocks.map((block) => <li key={`g-${block.partial_id}`}><a href={`/app/sites/${siteId}/partials/${block.partial_id}`}>{block.name}</a> <span className="muted text-sm">{block.kind === 'free' ? 'global block' : `${block.kind}, on every page`}</span></li>)}
                    {usage.templates.map((template) => <li key={`t-${template.template_id}`}><a href={`/app/sites/${siteId}/templates/${template.template_id}`}>{template.label}</a> <span className="muted text-sm">page template</span></li>)}
                    {usage.pages.map((page) => <li key={`p-${page.page_id}`}><a href={`/app/sites/${siteId}/pages/${page.page_id}`}>{page.title || page.slug}</a> <span className="muted text-sm">page</span></li>)}
                  </ul>
                )}
              <p className="muted text-sm">
                To show it, add a <strong>Navigation links</strong> block (for example in the header), set <strong>Links from</strong> to <strong>A site menu</strong> and
                <strong> Menu</strong> to <code className="menu-editor__code">{reference}</code>.
                {draft.locations.length ? ' A location follows whichever menu fills it.' : ' Give the menu a location to let blocks follow the location instead of this menu.'}
              </p>
            </section>

            {canEdit && (
              <section className="card stack-sm menu-editor__danger" aria-labelledby={`${domId}-delete`}>
                <h2 id={`${domId}-delete`} className="menu-editor__h">Delete menu</h2>
                {!confirmDelete ? (
                  <button type="button" className="btn btn--secondary btn--sm" onClick={() => { setConfirmDelete(true); pendingFocus.current = `${domId}-delete-confirm`; }}>Delete this menu…</button>
                ) : (
                  <div className="stack-sm" role="group" aria-label="Confirm deleting the menu">
                    <p className="text-sm">
                      Delete “{draft.name || menu.id}”? {usageCount > 0 ? `${usageCount} ${usageCount === 1 ? 'place shows' : 'places show'} it and will show no menu links. ` : ''}
                      Its history is kept, but the menu can't be restored from this page.
                    </p>
                    <div className="row" style={{ gap: 8 }}>
                      <button id={`${domId}-delete-confirm`} type="button" className="btn btn--danger btn--sm" disabled={deleting} onClick={deleteMenu}>{deleting ? 'Deleting…' : 'Delete menu'}</button>
                      <button type="button" className="btn btn--ghost btn--sm" disabled={deleting} onClick={() => setConfirmDelete(false)}>Cancel</button>
                    </div>
                  </div>
                )}
              </section>
            )}
          </aside>
        </div>
      )}
      {/* Raw text: React would escape the attribute selectors' quotes and break hydration. */}
      <style dangerouslySetInnerHTML={{ __html: MENU_EDITOR_CSS }} />
    </div>
  );
}

function MenuRow({ id, label, disabled, children }: {
  id: string; label: string; disabled: boolean;
  children: (handle: React.ReactNode) => React.ReactNode;
}) {
  const sortable = useSortable({ id, disabled });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(sortable.transform),
    transition: sortable.transition,
    opacity: sortable.isDragging ? 0.6 : 1,
  };
  const handle = (
    <button type="button" className="menu-editor__handle" aria-label={`Drag ${label} to reorder`} title="Drag to reorder"
      {...sortable.attributes} {...sortable.listeners}>
      <GripVertical size={15} aria-hidden="true" />
    </button>
  );
  return (
    <li ref={sortable.setNodeRef} style={style} className="menu-editor__item">
      {children(handle)}
    </li>
  );
}

function ItemFields({ id, item, pages, pagesById, label, onChange, onDone }: {
  id: string; item: MenuItem; pages: MenuEditorPage[]; pagesById: Map<string, MenuEditorPage>; label: string;
  onChange: (patch: Partial<MenuItem>) => void; onDone: () => void;
}) {
  const base = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const page = item.page_id ? pagesById.get(item.page_id) : undefined;
  const [choosing, setChoosing] = useState(false);
  const hrefError = item.type === 'url' ? hrefProblem(item.href ?? '') : null;
  const labelRequired = item.type === 'url' || item.type === 'heading';
  return (
    <div id={id} className="menu-editor__fields" role="group" aria-label={`Settings for ${label}`}>
      {(item.type === 'page' || item.type === 'children') && (
        <div className="field">
          <span className="menu-editor__label">{item.type === 'page' ? 'Page' : 'List the children of'}</span>
          {!choosing ? (
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <span>{page ? <><strong>{page.title}</strong> <span className="muted text-sm">{page.path}</span></> : <span className="menu-editor__field-error">The page no longer exists</span>}</span>
              <button type="button" className="btn btn--secondary btn--sm" onClick={() => setChoosing(true)}>Change page</button>
            </div>
          ) : (
            <PageSearch pages={pages} label={`a page for ${label}`} autoFocus
              onPick={(picked) => { onChange({ page_id: picked.id }); setChoosing(false); }} onCancel={() => setChoosing(false)} />
          )}
        </div>
      )}
      {item.type === 'url' && (
        <div className="field">
          <label htmlFor={`${base}-href`}>Address</label>
          <input id={`${base}-href`} value={item.href ?? ''} placeholder="https://example.com, /contact or #section" aria-invalid={!!hrefError}
            aria-describedby={hrefError ? `${base}-href-error` : undefined} onChange={(event) => onChange({ href: event.target.value })} />
          {hrefError && <span id={`${base}-href-error`} className="menu-editor__field-error">{hrefError}</span>}
        </div>
      )}
      <div className="field">
        <label htmlFor={`${base}-label`}>{labelRequired ? 'Label' : 'Label (optional)'}</label>
        <input id={`${base}-label`} value={item.label ?? ''} maxLength={120}
          placeholder={item.type === 'page' ? page?.title ?? '' : item.type === 'children' ? 'No label: the pages sit in place' : ''}
          aria-invalid={labelRequired && !(item.label ?? '').trim()} onChange={(event) => onChange({ label: event.target.value })} />
        {item.type === 'page' && <span className="muted text-sm">Leave empty to use the page's title, so the menu follows a rename.</span>}
        {item.type === 'children' && <span className="muted text-sm">With a label the pages become a submenu under it; without one they appear in place of this item.</span>}
      </div>
      <div className="field">
        <label htmlFor={`${base}-description`}>Description (optional)</label>
        <input id={`${base}-description`} value={item.description ?? ''} maxLength={200} onChange={(event) => onChange({ description: event.target.value })} />
        <span className="muted text-sm">A short line under the label in wide submenus.</span>
      </div>
      <div className="field">
        <span className="menu-editor__label">Icon (optional)</span>
        <IconPicker value={item.icon ?? ''} label={label} onChange={(icon) => onChange({ icon: icon ?? '' })} />
      </div>
      {item.type !== 'heading' && (
        <div className="field">
          <label htmlFor={`${base}-rel`}>Link relationship (optional)</label>
          <input id={`${base}-rel`} value={item.link_rel ?? ''} placeholder="nofollow sponsored" onChange={(event) => onChange({ link_rel: event.target.value })} />
        </div>
      )}
      <div><button type="button" className="btn btn--secondary btn--sm" onClick={onDone}>Done</button></div>
    </div>
  );
}

function PageSearch({ pages, label, onPick, onCancel, autoFocus, emptyText = 'The site has no pages with an address yet.' }: {
  pages: MenuEditorPage[]; label: string; onPick: (page: MenuEditorPage) => void; onCancel?: () => void; autoFocus?: boolean; emptyText?: string;
}) {
  const [query, setQuery] = useState('');
  const inputId = useId();
  const q = query.trim().toLowerCase();
  const results = (q ? pages.filter((page) => `${page.title} ${page.path}`.toLowerCase().includes(q)) : pages).slice(0, 30);
  return (
    <div className="menu-editor__search">
      <input id={inputId} type="search" placeholder="Search pages…" value={query} aria-label={`Search ${label}`} autoFocus={autoFocus}
        onChange={(event) => setQuery(event.target.value)} />
      {pages.length === 0 ? <p className="muted text-sm">{emptyText}</p> : (
        <ul className="menu-editor__results" aria-label="Pages">
          {results.map((page) => (
            <li key={page.id}>
              <button type="button" onClick={() => { onPick(page); setQuery(''); }}>
                <strong>{page.title}</strong> <span className="muted text-sm">{page.path}</span>
                {page.status && page.status !== 'published' && <span className="menu-editor__badge menu-editor__badge--warn">{page.status}</span>}
              </button>
            </li>
          ))}
          {!results.length && <li className="muted text-sm">No pages match.</li>}
        </ul>
      )}
      {onCancel && <button type="button" className="btn btn--ghost btn--sm" onClick={onCancel}>Keep the current page</button>}
    </div>
  );
}

function AddPanel({ items, pages, labelOf, atLimit, onAdd }: {
  items: MenuItem[]; pages: MenuEditorPage[]; labelOf: (item: MenuItem) => string; atLimit: boolean;
  onAdd: (item: Omit<MenuItem, 'id'>, parentId: string | null) => void;
}) {
  const base = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const [kind, setKind] = useState<MenuItemType>('page');
  const [parent, setParent] = useState('');
  const [label, setLabel] = useState('');
  const [href, setHref] = useState('');
  const [touched, setTouched] = useState(false);
  const targets = flattenItems(items).filter(({ item, depth }) => item.type !== 'children' && depth < MAX_MENU_DEPTH);
  const parentId = parent && canAddTo(items, parent) ? parent : null;
  const hrefError = hrefProblem(href);

  function addCustom(type: 'url' | 'heading') {
    setTouched(true);
    if (!label.trim() || (type === 'url' && hrefError)) return;
    onAdd(type === 'url' ? { type, label: label.trim(), href: href.trim() } : { type, label: label.trim() }, parentId);
    setLabel(''); setHref(''); setTouched(false);
  }

  return (
    <section className="card stack-sm" aria-labelledby={`${base}-add`}>
      <h2 id={`${base}-add`} className="menu-editor__h">Add items</h2>
      {atLimit && <p className="menu-editor__field-error">A menu holds at most {MAX_MENU_ITEMS} items.</p>}
      <div className="field">
        <label htmlFor={`${base}-parent`}>Add to</label>
        <select id={`${base}-parent`} value={parentId ?? ''} onChange={(event) => setParent(event.target.value)}>
          <option value="">The top level</option>
          {targets.map(({ item, depth }) => <option key={item.id} value={item.id}>{`${'— '.repeat(depth)}Under ${labelOf(item)}`}</option>)}
        </select>
      </div>
      <div className="menu-editor__kinds" role="radiogroup" aria-label="Kind of item">
        {(['page', 'children', 'url', 'heading'] as const).map((type) => (
          <label key={type} className={kind === type ? 'is-active' : ''}>
            <input type="radio" name={`${base}-kind`} value={type} checked={kind === type} onChange={() => { setKind(type); setTouched(false); }} />
            {type === 'page' ? 'Page' : type === 'children' ? "A page's children" : type === 'url' ? 'Custom link' : 'Heading'}
          </label>
        ))}
      </div>
      {kind === 'page' && (
        <PageSearch pages={pages} label="pages to add" onPick={(page) => onAdd({ type: 'page', page_id: page.id }, parentId)} />
      )}
      {kind === 'children' && (
        <>
          <p className="muted text-sm">Lists a page's published child pages, in page order, and keeps the list up to date by itself.</p>
          <PageSearch pages={pages.filter((page) => pages.some((child) => child.parent === page.id))} label="the parent page"
            emptyText="No page has child pages yet. Set a page's parent in its page settings."
            onPick={(page) => onAdd({ type: 'children', page_id: page.id }, parentId)} />
        </>
      )}
      {(kind === 'url' || kind === 'heading') && (
        <form className="stack-sm" noValidate onSubmit={(event) => { event.preventDefault(); addCustom(kind); }}>
          {kind === 'url' && (
            <div className="field">
              <label htmlFor={`${base}-href`}>Address</label>
              <input id={`${base}-href`} value={href} placeholder="https://example.com, /contact or #section" aria-invalid={touched && !!hrefError}
                aria-describedby={touched && hrefError ? `${base}-href-error` : undefined} onChange={(event) => setHref(event.target.value)} />
              {touched && hrefError && <span id={`${base}-href-error`} className="menu-editor__field-error">{hrefError}</span>}
            </div>
          )}
          <div className="field">
            <label htmlFor={`${base}-label`}>Label</label>
            <input id={`${base}-label`} value={label} maxLength={120} aria-invalid={touched && !label.trim()}
              aria-describedby={touched && !label.trim() ? `${base}-label-error` : undefined} onChange={(event) => setLabel(event.target.value)} />
            {touched && !label.trim() && <span id={`${base}-label-error`} className="menu-editor__field-error">Give the {kind === 'url' ? 'link' : 'heading'} a label</span>}
            {kind === 'heading' && <span className="muted text-sm">A heading has no link; it groups the items under it.</span>}
          </div>
          <button type="submit" className="btn btn--secondary btn--sm" disabled={atLimit}>Add {kind === 'url' ? 'link' : 'heading'}</button>
        </form>
      )}
    </section>
  );
}

function LocationsField({ locations, takenLocations, disabled, onChange }: {
  locations: string[]; takenLocations: Record<string, string>; disabled: boolean; onChange: (locations: string[]) => void;
}) {
  const base = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const [custom, setCustom] = useState('');
  const options = [...new Set([...MENU_LOCATIONS, ...locations, ...Object.keys(takenLocations)])];
  const set = (location: string, on: boolean) => onChange(on ? [...locations, location] : locations.filter((value) => value !== location));
  const normalized = normalizeLocation(custom);
  function addCustom() {
    if (!normalized || locations.includes(normalized)) return;
    onChange([...locations, normalized]);
    setCustom('');
  }
  return (
    <fieldset className="menu-editor__locations" disabled={disabled}>
      <legend>Locations</legend>
      <p className="muted text-sm">A location names a place on the site. Each location shows one menu; blocks that show a location follow whichever menu fills it.</p>
      <div className="menu-editor__location-options">
        {options.map((location) => (
          <label key={location} className="menu-editor__check">
            <input type="checkbox" checked={locations.includes(location)} onChange={(event) => set(location, event.target.checked)} />
            <span>
              {LOCATION_LABELS[location] ?? location} <code className="menu-editor__code">{location}</code>
              {takenLocations[location] && <span className="menu-editor__taken">{takenLocationNote(takenLocations[location], locations.includes(location))}</span>}
            </span>
          </label>
        ))}
      </div>
      <div className="menu-editor__custom-location">
        <label htmlFor={`${base}-custom`} className="menu-editor__label">Custom location</label>
        <div className="row" style={{ gap: 8 }}>
          <input id={`${base}-custom`} value={custom} placeholder="sidebar" maxLength={40}
            onChange={(event) => setCustom(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); addCustom(); } }} />
          <button type="button" className="btn btn--secondary btn--sm" disabled={!normalized || locations.includes(normalized)} onClick={addCustom}>Add</button>
        </div>
        {custom.trim() && normalized && normalized !== custom.trim() && <span className="muted text-sm">Saved as <code className="menu-editor__code">{normalized}</code></span>}
      </div>
    </fieldset>
  );
}

function PreviewList({ items }: { items: ResolvedMenuItem[] }) {
  return (
    <ul className="menu-editor__preview">
      {items.map((item) => (
        <li key={item.id}>
          {item.href !== null ? <span className="menu-editor__preview-link" title={item.href}>{item.label}</span> : <span className="menu-editor__preview-heading">{item.label}</span>}
          {item.description && <span className="muted text-sm"> — {item.description}</span>}
          {item.children.length > 0 && <PreviewList items={item.children} />}
        </li>
      ))}
    </ul>
  );
}

const MENU_EDITOR_CSS = `
.menu-editor { display: grid; gap: 1rem; max-width: 1200px; min-width: 0; }
.menu-editor__bar { display: flex; align-items: center; justify-content: space-between; gap: 1rem; flex-wrap: wrap; padding: .75rem 1rem; position: sticky; top: 0; z-index: 2; }
.menu-editor__status { font-size: .9rem; color: var(--color-text-muted); }
.menu-editor__grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(280px, 380px); gap: 1rem; align-items: start; }
.menu-editor__main, .menu-editor__side { display: grid; gap: 1rem; min-width: 0; }
@media (max-width: 960px) { .menu-editor__grid { grid-template-columns: minmax(0, 1fr); } }
.menu-editor__h { font-size: .78rem; font-weight: 600; letter-spacing: .14em; text-transform: uppercase; color: var(--color-text-muted); }
.menu-editor__section-head { display: flex; align-items: baseline; justify-content: space-between; gap: .75rem; flex-wrap: wrap; margin-bottom: .75rem; }
.menu-editor__label { font-size: .875rem; font-weight: 500; }
.menu-editor__check { display: flex; gap: .5rem; align-items: flex-start; font-size: .9rem; cursor: pointer; }
.menu-editor__check input { margin-top: .25rem; }
.menu-editor__locations { border: 0; padding: 0; margin: 0; min-width: 0; display: grid; gap: .5rem; }
.menu-editor__locations legend { font-size: .875rem; font-weight: 500; padding: 0; margin-bottom: .25rem; }
.menu-editor__location-options { display: grid; gap: .35rem; }
.menu-editor__custom-location { display: grid; gap: .25rem; }
.menu-editor__custom-location input, .menu-editor__search input, .menu-editor__fields input, .menu-editor .field select {
  padding: .5rem .75rem; border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-surface); min-width: 0; width: 100%;
}
.menu-editor__taken { color: #b45309; font-size: .82rem; }
.menu-editor__code { font-family: var(--font-mono); font-size: .82em; background: var(--color-bg); padding: 1px 5px; border-radius: 4px; }
.menu-editor__list { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
.menu-editor__list--nested { margin: 6px 0 0 1.5rem; padding-left: .75rem; border-left: 2px solid var(--color-border); }
.menu-editor__item { min-width: 0; }
.menu-editor__row { display: flex; align-items: center; gap: 4px; padding: 4px 6px; border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-surface); min-width: 0; flex-wrap: wrap; }
.menu-editor__row--error { border-color: var(--color-danger); }
.menu-editor__row-text { flex: 1 1 12rem; min-width: 0; display: flex; flex-wrap: wrap; align-items: baseline; gap: .25rem .5rem; padding: 4px 2px; }
.menu-editor__row-label { font-weight: 500; overflow-wrap: anywhere; }
.menu-editor__row-detail { font-size: .8rem; color: var(--color-text-muted); overflow-wrap: anywhere; }
.menu-editor__badge { font-size: .72rem; padding: 0 7px; border-radius: 999px; background: var(--color-bg); border: 1px solid var(--color-border); color: var(--color-text-muted); white-space: nowrap; }
.menu-editor__badge--url { background: #eff6ff; border-color: #bfdbfe; color: #1d4ed8; }
.menu-editor__badge--children { background: #f0fdf4; border-color: #bbf7d0; color: #15803d; }
.menu-editor__badge--heading { background: #faf5ff; border-color: #e9d5ff; color: #7e22ce; }
.menu-editor__badge--warn { background: #fffbeb; border-color: #fde68a; color: #b45309; }
.menu-editor__actions { display: inline-flex; flex-wrap: wrap; gap: 2px; }
.menu-editor__actions button, .menu-editor__handle {
  display: inline-grid; place-items: center; width: 32px; height: 32px; padding: 0; border: 0; border-radius: var(--radius-sm);
  background: none; color: var(--color-text-muted); cursor: pointer;
}
.menu-editor__handle { cursor: grab; touch-action: none; }
.menu-editor__actions button:hover:not(:disabled), .menu-editor__handle:hover { background: var(--color-bg); color: var(--color-text); }
.menu-editor__actions button:disabled { opacity: .35; cursor: not-allowed; }
.menu-editor__actions button[aria-expanded="true"] { background: var(--color-bg); color: var(--color-text); }
.menu-editor button:focus-visible, .menu-editor input:focus-visible, .menu-editor select:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 2px; }
.menu-editor__fields { display: grid; gap: .75rem; margin: 6px 0 0; padding: .75rem; border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-bg); }
.menu-editor__errors { margin: 4px 0 0; padding-left: 1.25rem; color: var(--color-danger); font-size: .85rem; }
.menu-editor__field-error { color: var(--color-danger); font-size: .85rem; }
.menu-editor__empty { padding: 1.5rem; text-align: center; border: 1px dashed var(--color-border); border-radius: var(--radius-md); }
.menu-editor__undo { display: flex; align-items: center; gap: .5rem; margin-top: .75rem; font-size: .9rem; }
.menu-editor__sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.menu-editor__problem { padding: .75rem 1rem; border-radius: var(--radius-md); border: 1px solid var(--color-danger); background: #fef2f2; display: grid; gap: .5rem; }
.menu-editor__problem--stale, .menu-editor__problem--location { border-color: #f59e0b; background: #fffbeb; }
.menu-editor__kinds { display: flex; flex-wrap: wrap; gap: 4px; }
.menu-editor__kinds label { display: inline-flex; align-items: center; gap: 4px; padding: .3rem .6rem; border: 1px solid var(--color-border); border-radius: 999px; font-size: .85rem; cursor: pointer; }
.menu-editor__kinds label.is-active { border-color: var(--color-primary); background: var(--color-bg); }
.menu-editor__kinds label:focus-within { outline: 2px solid var(--color-accent); outline-offset: 2px; }
.menu-editor__kinds input { position: absolute; opacity: 0; pointer-events: none; }
.menu-editor__search { display: grid; gap: .5rem; }
.menu-editor__results { list-style: none; margin: 0; padding: 0; max-height: 260px; overflow-y: auto; border: 1px solid var(--color-border); border-radius: var(--radius-md); }
.menu-editor__results li + li { border-top: 1px solid var(--color-border); }
.menu-editor__results button { display: flex; flex-wrap: wrap; gap: .25rem .5rem; align-items: baseline; width: 100%; padding: .45rem .6rem; border: 0; background: var(--color-surface); text-align: left; cursor: pointer; }
.menu-editor__results button:hover { background: var(--color-bg); }
.menu-editor__results li.muted { padding: .45rem .6rem; }
.menu-editor__preview { list-style: disc; margin: 0; padding-left: 1.25rem; display: grid; gap: 2px; }
.menu-editor__preview .menu-editor__preview { margin-top: 2px; list-style: circle; }
.menu-editor__preview-link { color: var(--color-primary); text-decoration: underline; text-underline-offset: 2px; }
.menu-editor__preview-heading { font-weight: 600; }
.menu-editor__warnings { margin: 0; padding-left: 1.25rem; font-size: .82rem; color: #b45309; }
.menu-editor__usage { margin: 0; padding-left: 1.25rem; display: grid; gap: 2px; }
.menu-editor .tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--color-border); }
.menu-editor .tabs button { padding: .5rem .75rem; background: none; border: 0; cursor: pointer; color: var(--color-text-muted); font-weight: 500; border-bottom: 2px solid transparent; margin-bottom: -1px; }
.menu-editor .tabs button.is-active { color: var(--color-text); border-bottom-color: var(--color-primary); }
.menu-editor .icon-picker__swatch, .menu-editor .icon-picker__btn, .menu-editor .icon-picker__icon, .menu-editor .icon-picker__search, .menu-editor .icon-picker__panel {
  background: var(--color-surface); color: var(--color-text); border-color: var(--color-border);
}
.menu-editor .icon-picker__name, .menu-editor .icon-picker__count { color: var(--color-text-muted); }
.menu-editor .icon-picker__icon[aria-pressed="true"] { background: var(--color-bg); border-color: var(--color-primary); }
`;
