// Block-mode page editor.
//
// Three-column layout matching the HtmlPageEditor pattern:
//   - Left: two tabs ("Add" — block library, "Structure" — tree)
//   - Center: preview iframe (re-renders on save)
//   - Right: field form for the selected block, generated from its schema
//
// Mutations call the v1 block-tree routes (POST/PATCH/PUT/DELETE
// /api/v1/sites/{id}/pages/{pageId}/blocks). State is mirrored locally for
// optimistic UI; on failure the server response replaces the local copy.
//
// DnD v1: same-parent reorder via @dnd-kit/sortable. Cross-parent /
// cross-slot moves use a "Move into…" button on each tree node — drag
// across containers is a Phase 2.5 polish.

import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import type { Block, BlockType, Page, Breakpoint, WorkingCopy, FieldDefinition } from '@typeroll/shared';
import { CORE_BLOCK_TYPES, resolveResponsive, isResponsiveValue, BREAKPOINTS } from '@typeroll/shared';
import {
  DndContext, DragOverlay, useDraggable, useDroppable,
} from '@dnd-kit/core';
import {
  SortableContext, useSortable, verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useBlockDnd, type CanvasGeometry, type DropTarget } from './block-dnd';
import { createBlockHistory } from './block-history';
import ReviewChanges from './ReviewChanges';
import {
  Monitor, Tablet, Smartphone, ChevronRight, ChevronDown,
  Trash2, Copy, GripVertical, Plus, Square, Columns, Type, Heading, Image as ImageIcon, MousePointerClick,
  ArrowLeft, SlidersHorizontal, Undo2, Redo2,
} from 'lucide-react';
import { DocStatus } from './EditorStatus';
import PublishMenu, { PAGE_STATUS_OPTIONS } from './PublishMenu';
import ContentModeSwitcher from './ContentModeSwitcher';
import TemplatePicker from './TemplatePicker';

interface Props {
  siteId: string;
  page: Page;
  /** Unsaved autosaved edits, loaded server-side. Overlaid on `page` at mount. */
  workingCopy?: WorkingCopy | null;
  previewUrl: string;
  /** Permalink on the deployed site (null when the site has no live base). */
  liveUrl?: string | null;
  lastDeployedAt: string | null;
}

type Status = 'idle' | 'saving' | 'saved' | 'error';
type LeftTab = 'add' | 'structure';
const LEFT_TAB_STORAGE_KEY = 'typeroll.block-editor.left-tab';

// The editor's device presets map 1:1 onto the five fixed responsive
// breakpoints (mobile/tablet/laptop/desktop/wide). Picking a device does two
// things: it sets the preview iframe width (approximate — a narrow editor
// panel may cap the larger presets) AND it sets the *active editing
// breakpoint*, so changing a responsive field (e.g. grid columns) writes to
// that breakpoint. Device labels follow the user's mental model; the title
// carries the exact min-width that breakpoint actually triggers at.
interface DevicePreset {
  bp: Breakpoint;
  label: string;
  icon: IconCmp;
  /** Render the icon rotated 90° to read as a landscape orientation. */
  landscape?: boolean;
  /** Preview frame width. '100%' fills the panel (widest preset). */
  width: number | '100%';
}

const DEVICES: DevicePreset[] = [
  { bp: 'mobile', label: 'Phone', icon: Smartphone as IconCmp, width: 390 },
  { bp: 'tablet', label: 'Phone — landscape', icon: Smartphone as IconCmp, landscape: true, width: 740 },
  { bp: 'laptop', label: 'Tablet', icon: Tablet as IconCmp, width: 1024 },
  { bp: 'desktop', label: 'Tablet — landscape', icon: Tablet as IconCmp, landscape: true, width: 1280 },
  { bp: 'wide', label: 'Desktop', icon: Monitor as IconCmp, width: '100%' },
];

export const DEFAULT_BP: Breakpoint = 'desktop';

type IconCmp = React.ComponentType<{ size?: number }>;
export const ICONS: Record<string, IconCmp> = {
  section: Square as IconCmp,
  columns: Columns as IconCmp,
  prose: Type as IconCmp,
  heading: Heading as IconCmp,
  image: ImageIcon as IconCmp,
  button: MousePointerClick as IconCmp,
};

// ─── Top-level component ────────────────────────────────────────────────

export default function BlockPageEditor({ siteId, page, workingCopy, previewUrl, liveUrl, lastDeployedAt }: Props) {
  // The editor edits the working-copy view of the page: canonical doc with
  // any unsaved (autosaved) fields overlaid. All edits autosave to the
  // working copy; the deliberate Save in the Publish menu promotes them.
  const [draft, setDraft] = useState<Page>({ ...page, ...(workingCopy?.fields ?? {}) } as Page);
  const [hasWc, setHasWc] = useState<boolean>(!!workingCopy);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Mirrors for the iframe event handlers (installed once, must read latest).
  const selectedIdRef = useRef<string | null>(null);
  selectedIdRef.current = selectedId;
  const hoverIdRef = useRef<string | null>(null);
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string | null>(null);
  const [activeBp, setActiveBp] = useState<Breakpoint>(DEFAULT_BP);
  // Undo/redo over the block tree. Snapshots record every successful block
  // mutation (server-authoritative state); applying a step PUTs the
  // snapshot back into the working copy — undo never touches the saved
  // page. histTick re-renders the toolbar buttons' disabled states.
  const historyRef = useRef<ReturnType<typeof createBlockHistory> | null>(null);
  if (!historyRef.current) {
    historyRef.current = createBlockHistory();
    const wcBlocks = (workingCopy?.fields as { blocks?: Block[] } | undefined)?.blocks;
    historyRef.current.init(wcBlocks ?? ((page.blocks ?? []) as Block[]));
  }
  const [, setHistTick] = useState(0);
  const bumpHist = () => setHistTick((t) => t + 1);
  const [reviewOpen, setReviewOpen] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const canvasId = useMemo(
    () => `canvas-${siteId}-${page.id}-editorbridge`.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 128),
    [siteId, page.id],
  );
  const canvasGeometryRef = useRef<CanvasGeometry | null>(null);
  const canvasScrollRef = useRef(0);
  const restoreCanvasScrollRef = useRef<number | null>(null);
  const extensionPreviewContextRef = useRef<Record<string, Record<string, string>>>({});
  function postCanvasCommand(command: Record<string, unknown>): void {
    iframeRef.current?.contentWindow?.postMessage({
      channel: 'typeroll.editor-canvas', version: 1, canvas_id: canvasId, ...command,
    }, '*');
  }
  // Live preview zoom, read by the canvas hit-test to map on-screen pointer
  // coords into the (unscaled) iframe coordinate space.
  const scaleRef = useRef(1);
  function reloadPreview(): void {
    const ifr = iframeRef.current;
    if (!ifr) return;
    restoreCanvasScrollRef.current = canvasScrollRef.current;
    canvasGeometryRef.current = null;
    ifr.src = ifr.src;
  }
  // Center-panel size, tracked so a fixed-width device preset wider than the
  // panel scales DOWN to fit (instead of being capped to the panel width,
  // which would silently show a smaller breakpoint than the one selected).
  const centerRef = useRef<HTMLElement>(null);
  const [panelSize, setPanelSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = centerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const measure = () => setPanelSize({ w: el.clientWidth, h: el.clientHeight });
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, []);
  // Derived from props only, so SSR and the first client render agree — the
  // tab drives inline styles, and reading localStorage here made the two
  // disagree and blew up hydration for anyone with a stored preference.
  const [leftTab, setLeftTab] = useState<LeftTab>(
    (page.blocks?.length ?? 0) > 0 ? 'structure' : 'add',
  );

  // The stored preference is applied after mount instead.
  useEffect(() => {
    const stored = window.localStorage.getItem(LEFT_TAB_STORAGE_KEY);
    if (stored === 'add' || stored === 'structure') setLeftTab(stored);
  }, []);

  const leftTabMounted = useRef(false);
  useEffect(() => {
    // Skip the first run: it fires with the props-derived default, which
    // would overwrite the stored preference before the effect above reads it.
    if (!leftTabMounted.current) {
      leftTabMounted.current = true;
      return;
    }
    window.localStorage.setItem(LEFT_TAB_STORAGE_KEY, leftTab);
  }, [leftTab]);

  // Build the block-type registry once. Custom blocks come from a separate
  // fetch below.
  const [customTypes, setCustomTypes] = useState<BlockType[]>([]);
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/sites/${siteId}/blocks/list`)
      .then((r) => r.ok ? r.json() as Promise<{ block_types: BlockType[] }> : Promise.resolve({ block_types: [] }))
      .then((j) => { if (!cancelled) setCustomTypes(j.block_types ?? []); })
      .catch(() => { /* not fatal */ });
    return () => { cancelled = true; };
  }, [siteId]);

  const registry = useMemo(() => {
    const m = new Map<string, BlockType>();
    for (const bt of CORE_BLOCK_TYPES) m.set(bt.id, bt);
    for (const bt of customTypes) m.set(bt.id, bt);
    return m;
  }, [customTypes]);

  const selected = useMemo(() => {
    if (!selectedId) return null;
    return findBlock(draft.blocks ?? [], selectedId);
  }, [draft.blocks, selectedId]);

  async function refresh(): Promise<void> {
    const res = await fetch(`/api/sites/${siteId}/pages/${page.id}/blocks`, {
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return;
    const body = await res.json() as { blocks?: Block[] };
    setDraft((d) => ({ ...d, blocks: body.blocks ?? [] }));
    reloadPreview();
  }

  async function callMutation(args: {
    method: 'POST' | 'PATCH' | 'PUT' | 'DELETE';
    body?: Record<string, unknown>;
    query?: Record<string, string>;
    /** History coalescing signature — same sig within the window = one undo step. */
    histSig?: string;
  }): Promise<{ blocks?: Block[]; added_id?: string } | null> {
    setStatus('saving');
    setError(null);
    // Block mutations always target the working copy server-side (buffer
    // model) — the saved page only changes on the deliberate Save.
    const url = new URL(`/api/sites/${siteId}/pages/${page.id}/blocks`, window.location.origin);
    if (args.query) for (const [k, v] of Object.entries(args.query)) url.searchParams.set(k, v);
    try {
      const res = await fetch(url.toString(), {
        method: args.method,
        headers: { 'content-type': 'application/json' },
        body: args.body ? JSON.stringify(args.body) : undefined,
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(j.error ?? `${args.method} failed (${res.status})`);
      }
      const result = await res.json() as { blocks?: Block[]; added_id?: string };
      if (result.blocks) {
        setDraft((d) => ({ ...d, blocks: result.blocks }));
        setHasWc(true);
        historyRef.current?.record(result.blocks, args.histSig);
        bumpHist();
        reloadPreview();
      }
      setStatus('saved');
      window.setTimeout(() => setStatus('idle'), 1200);
      return result;
    } catch (e) {
      setError((e as Error).message);
      setStatus('error');
      return null;
    }
  }

  async function handleAddBlock(
    typeId: string,
    parentId: string | null = null,
    slotIndex?: number,
    position?: number,
  ): Promise<void> {
    const bt = registry.get(typeId);
    const data: Record<string, unknown> = {};
    if (bt) {
      for (const f of bt.schema) {
        if (f.default !== undefined) data[f.name] = f.default;
      }
    }
    const result = await callMutation({
      method: 'POST',
      body: {
        block: { type: typeId, data },
        parent_id: parentId,
        slot_index: slotIndex,
        position,
      },
    });
    if (result?.added_id) setSelectedId(result.added_id);
  }

  async function handleRemove(blockId: string): Promise<void> {
    if (!confirm('Delete this block and everything inside it?')) return;
    await callMutation({ method: 'DELETE', query: { block_id: blockId } });
    if (selectedId === blockId) setSelectedId(null);
  }

  async function handleDuplicate(blockId: string): Promise<void> {
    const result = await callMutation({ method: 'POST', body: { duplicate_of: blockId } });
    if (result?.added_id) setSelectedId(result.added_id);
  }

  async function handleUpdateData(blockId: string, data: Record<string, unknown>): Promise<void> {
    // Coalesce debounced typing in the same block+field into one undo step.
    const sig = `patch:${blockId}:${Object.keys(data).sort().join(',')}`;
    await callMutation({ method: 'PATCH', body: { block_id: blockId, data }, histSig: sig });
  }

  // ─── Undo / redo ──────────────────────────────────────────────────────
  // A step re-applies a recorded snapshot by PUTting it into the working
  // copy (whole-field `blocks` write — the same channel meta autosave
  // uses). On network failure the pointer is rolled back so the stack
  // never drifts from what's actually on the server.
  async function applyHistory(direction: 'undo' | 'redo'): Promise<void> {
    const h = historyRef.current;
    if (!h || status === 'saving') return;
    const snap = direction === 'undo' ? h.undo() : h.redo();
    if (!snap) return;
    setStatus('saving');
    setError(null);
    try {
      const res = await fetch(`/api/sites/${siteId}/working-copy/page/${page.id}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fields: { blocks: snap } }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(j.error ?? `${direction} failed (${res.status})`);
      }
      setDraft((d) => ({ ...d, blocks: snap }));
      setHasWc(true);
      if (selectedIdRef.current && !findBlock(snap, selectedIdRef.current)) setSelectedId(null);
      setStatus('saved');
      window.setTimeout(() => setStatus('idle'), 1200);
      reloadPreview();
    } catch (e) {
      if (direction === 'undo') h.revertUndo(); else h.revertRedo();
      setError((e as Error).message);
      setStatus('error');
    }
    bumpHist();
  }
  // Keyboard shortcuts. Installed once; handlers go through a ref so the
  // stable listener always sees the latest closures. Editable targets are
  // skipped — text inputs keep native undo/select-all, and Delete while
  // typing must never remove a block.
  const shortcutsRef = useRef({
    history: applyHistory,
    duplicate: handleDuplicate,
    remove: handleRemove,
    save: saveAll,
  });
  shortcutsRef.current = { history: applyHistory, duplicate: handleDuplicate, remove: handleRemove, save: saveAll };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      const s = shortcutsRef.current;
      const mod = e.metaKey || e.ctrlKey;
      const k = e.key.toLowerCase();
      if (mod && k === 'z') {
        e.preventDefault();
        void s.history(e.shiftKey ? 'redo' : 'undo');
      } else if (mod && k === 'y') {
        e.preventDefault();
        void s.history('redo');
      } else if (mod && k === 'd' && selectedIdRef.current) {
        e.preventDefault();
        void s.duplicate(selectedIdRef.current);
      } else if (mod && k === 's') {
        // Take over the browser's save-page dialog even with nothing selected.
        e.preventDefault();
        void s.save();
      } else if (!mod && (e.key === 'Delete' || e.key === 'Backspace') && selectedIdRef.current) {
        e.preventDefault();
        void s.remove(selectedIdRef.current);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  async function handleRename(blockId: string, name: string): Promise<void> {
    // Empty name clears the custom label back to the derived one (server trims).
    await callMutation({ method: 'PATCH', body: { block_id: blockId, name } });
  }

  async function handleMove(blockId: string, targetParentId: string | null, targetSlotIndex?: number, targetPosition?: number): Promise<void> {
    await callMutation({
      method: 'PUT',
      body: {
        block_id: blockId,
        target_parent_id: targetParentId,
        target_slot_index: targetSlotIndex,
        target_position: targetPosition,
      },
    });
  }

  // ─── Drag-and-drop (library → tree, tree → tree) ──────────────────────
  // The shared hook owns the drag session for the whole left panel; it
  // computes the live drop position (container + gap) that the colored
  // drop-line renders, and dispatches an add or move on drop.
  const dnd = useBlockDnd({
    blocks: draft.blocks ?? [],
    registry,
    icons: ICONS,
    onAdd: (typeId, parentId, slotIdx, position) => void handleAddBlock(typeId, parentId, slotIdx, position),
    onMove: (blockId, parentId, slotIdx, position) => void handleMove(blockId, parentId, slotIdx, position),
    // Reveal the tree so a library-dragged block has a landing zone.
    onNewDragStart: () => setLeftTab('structure'),
    // Also let blocks be dropped straight onto the live preview canvas.
    canvas: {
      getIframe: () => iframeRef.current,
      getScale: () => scaleRef.current,
      getGeometry: () => canvasGeometryRef.current,
      sendCommand: postCanvasCommand,
    },
  });

  // ─── Page meta (title + SEO) ──────────────────────────────────────────
  // Block content autosaves through the /blocks endpoint (working-copy
  // mode); page metadata autosaves to the same working copy via the
  // working-copy PUT. Nothing touches the canonical page until saveAll().
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const registryRef = useRef(registry);
  registryRef.current = registry;

  // ─── Opaque-origin editor canvas bridge ───────────────────────────────
  const inlineCommitRef = useRef(handleUpdateData);
  inlineCommitRef.current = handleUpdateData;

  useEffect(() => {
    const ifr = iframeRef.current;
    if (!ifr) return;
    const firstExisting = (ids: unknown): string | null => {
      if (!Array.isArray(ids)) return null;
      return ids.find((id): id is string => typeof id === 'string' && Boolean(findBlock(draftRef.current.blocks ?? [], id))) ?? null;
    };
    const receive = (event: MessageEvent) => {
      if (event.source !== ifr.contentWindow) return;
      const data = event.data as Record<string, unknown> | null;
      if (!data || data.channel !== 'typeroll.editor-canvas' || data.version !== 1 || data.canvas_id !== canvasId) return;
      if (data.type === 'geometry' && Array.isArray(data.blocks) && data.body && typeof data.body === 'object') {
        canvasGeometryRef.current = { blocks: data.blocks.slice(0, 5000), body: data.body } as CanvasGeometry;
      } else if (data.type === 'select') {
        setSelectedId(firstExisting(data.ancestor_ids));
      } else if (data.type === 'hover') {
        const id = firstExisting(data.ancestor_ids);
        if (id !== hoverIdRef.current) {
          hoverIdRef.current = id;
          postCanvasCommand({ action: 'highlight', selected_id: selectedIdRef.current, hover_id: id });
        }
      } else if (data.type === 'edit' && typeof data.block_id === 'string' && typeof data.field === 'string' && typeof data.value === 'string' && data.value.length <= 100_000) {
        if (findBlock(draftRef.current.blocks ?? [], data.block_id)) void inlineCommitRef.current(data.block_id, { [data.field]: data.value });
      } else if (data.type === 'scroll' && typeof data.scroll_y === 'number' && Number.isFinite(data.scroll_y)) {
        canvasScrollRef.current = data.scroll_y;
      } else if (data.type === 'ready') {
        postCanvasCommand({ action: 'highlight', selected_id: selectedIdRef.current, hover_id: hoverIdRef.current });
        const labels: Record<string, string> = {};
        forEachBlock(draftRef.current.blocks ?? [], (block) => {
          const label = placeholderLabelFor(block, registryRef.current.get(block.type));
          if (label) labels[block.id] = label;
        });
        postCanvasCommand({ action: 'placeholders', labels });
        postCanvasCommand({ action: 'extension_context', context: extensionPreviewContextRef.current });
        if (restoreCanvasScrollRef.current !== null) {
          postCanvasCommand({ action: 'scroll', scroll_y: restoreCanvasScrollRef.current });
          restoreCanvasScrollRef.current = null;
        }
        postCanvasCommand({ action: 'geometry' });
      }
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, [canvasId]);

  // Keep the canvas outline in sync when selection changes from the tree.
  useEffect(() => {
    postCanvasCommand({ action: 'highlight', selected_id: selectedId, hover_id: hoverIdRef.current });
  }, [selectedId, canvasId]);

  const metaSaveTimer = useRef<number | null>(null);
  const pendingMeta = useRef<Record<string, unknown>>({});

  async function flushMetaToWc(): Promise<void> {
    const fields = pendingMeta.current;
    if (Object.keys(fields).length === 0) return;
    pendingMeta.current = {};
    setStatus('saving');
    setError(null);
    try {
      const res = await fetch(`/api/sites/${siteId}/working-copy/page/${page.id}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fields }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(j.error ?? `Autosave failed (${res.status})`);
      }
      setHasWc(true);
      setStatus('saved');
      window.setTimeout(() => setStatus('idle'), 1200);
      reloadPreview();
    } catch (e) {
      // Keep the fields pending so the next edit retries them.
      pendingMeta.current = { ...fields, ...pendingMeta.current };
      setError((e as Error).message);
      setStatus('error');
    }
  }

  function updateMeta<K extends keyof Page>(key: K, value: Page[K]): void {
    setDraft((d) => ({ ...d, [key]: value }));
    pendingMeta.current[key] = value;
    if (metaSaveTimer.current) window.clearTimeout(metaSaveTimer.current);
    metaSaveTimer.current = window.setTimeout(() => { void flushMetaToWc(); }, 700);
  }

  // ─── Deliberate actions (Publish menu) ────────────────────────────────

  /** Save = commit the working copy server-side through the shared commit
   *  path (revision snapshot, SEO transform, redirect hygiene — same as
   *  agents use via the v1 API). Status is deliberately excluded — it has
   *  its own action below and never rides along with a content save. */
  async function saveAll(): Promise<void> {
    if (metaSaveTimer.current) window.clearTimeout(metaSaveTimer.current);
    setStatus('saving');
    setError(null);
    const wcUrl = `/api/sites/${siteId}/working-copy/page/${page.id}`;
    const fields = pendingMeta.current;
    pendingMeta.current = {};
    try {
      if (Object.keys(fields).length > 0) {
        const flush = await fetch(wcUrl, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ fields }),
        });
        if (!flush.ok) {
          const j = await flush.json().catch(() => ({})) as { error?: string };
          throw new Error(j.error ?? `Save failed (${flush.status})`);
        }
      }
      const res = await fetch(wcUrl, { method: 'POST' });
      if (!res.ok) {
        const j = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(j.error ?? `Save failed (${res.status})`);
      }
      setHasWc(false);
      setDraft((d) => ({ ...d, date_updated: new Date().toISOString() }));
      setStatus('saved');
      window.setTimeout(() => setStatus('idle'), 1200);
    } catch (e) {
      // Keep unflushed fields pending so the next attempt retries them.
      pendingMeta.current = { ...fields, ...pendingMeta.current };
      setError((e as Error).message);
      setStatus('error');
    }
  }

  async function discardWc(): Promise<void> {
    await fetch(`/api/sites/${siteId}/working-copy/page/${page.id}`, { method: 'DELETE' });
    // Reload so the editor re-mounts from canonical state — simplest way to
    // guarantee no stale working-copy fields linger in client state.
    window.location.reload();
  }

  async function changeSchedule(field: 'publish_at' | 'unpublish_at', iso: string | null): Promise<void> {
    setStatus('saving');
    setError(null);
    try {
      const res = await fetch(`/api/sites/${siteId}/pages/${page.id}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ [field]: iso }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(j.error ?? `Scheduling failed (${res.status})`);
      }
      setDraft((d) => ({ ...d, [field]: iso }));
      setStatus('saved');
      window.setTimeout(() => setStatus('idle'), 1200);
    } catch (e) {
      setError((e as Error).message);
      setStatus('error');
    }
  }

  async function changeStatus(next: string): Promise<void> {
    setStatus('saving');
    setError(null);
    try {
      const res = await fetch(`/api/sites/${siteId}/pages/${page.id}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: next }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(j.error ?? `Status change failed (${res.status})`);
      }
      setDraft((d) => ({ ...d, status: next as Page['status'], date_updated: new Date().toISOString() }));
      setStatus('saved');
      window.setTimeout(() => setStatus('idle'), 1200);
      reloadPreview();
    } catch (e) {
      setError((e as Error).message);
      setStatus('error');
    }
  }

  const deviceWidth = (DEVICES.find((d) => d.bp === activeBp) ?? DEVICES[DEVICES.length - 1]).width;
  // Scale-to-fit math: a numeric preset wider than the available panel is
  // shrunk with a CSS transform so its FULL width still renders (the iframe's
  // own @media queries then react to the real preset width, not the panel's).
  const numericW = typeof deviceWidth === 'number' ? deviceWidth : null;
  const availW = Math.max(1, panelSize.w - 32); // centerPanel has 1rem padding each side
  const availH = Math.max(1, panelSize.h - 32);
  const previewScale = numericW ? Math.min(1, availW / numericW) : 1;
  scaleRef.current = previewScale;
  const frameW: number | string = numericW ?? '100%';
  const frameH: number | string = numericW ? availH / previewScale : '100%';
  const selectedBlockType = selected ? registry.get(selected.block.type) : undefined;

  function configureExtensionPreview(): void {
    const componentId = selectedBlockType?.extension?.component_id;
    if (!componentId) return;
    const current = extensionPreviewContextRef.current[componentId] ?? {};
    const value = window.prompt(
      'Synthetic URL context for this preview only (JSON object). It is never saved in block data.',
      JSON.stringify(current, null, 2),
    );
    if (value === null) return;
    try {
      const parsed = JSON.parse(value) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.values(parsed).some((entry) => typeof entry !== 'string')) {
        throw new Error('Every value must be a string.');
      }
      extensionPreviewContextRef.current = {
        ...extensionPreviewContextRef.current,
        [componentId]: parsed as Record<string, string>,
      };
      postCanvasCommand({ action: 'extension_context', context: extensionPreviewContextRef.current });
    } catch (contextError) {
      setError(contextError instanceof Error ? contextError.message : 'Invalid preview context');
    }
  }

  return (
    <div style={shell}>
      <header style={topBar}>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          <a href={`/app/sites/${siteId}/pages`} style={exitBtn} title="Exit editor">
            <ArrowLeft size={14} /> Exit editor
          </a>
          <strong style={{ fontSize: '0.9rem' }}>{draft.title}</strong>
          <span style={{ fontSize: '0.75rem', opacity: 0.6 }}>/{draft.slug}</span>
          <DocStatus
            save={status}
            dirty={hasWc}
            error={error}
            pubStatus={draft.status}
            docUpdatedAt={draft.date_updated ?? null}
            lastDeployedAt={lastDeployedAt}
          />
        </div>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          <div style={{ display: 'flex', gap: '0.125rem' }}>
            <button
              type="button"
              style={histBtn(!historyRef.current?.canUndo())}
              disabled={!historyRef.current?.canUndo()}
              onClick={() => void applyHistory('undo')}
              title="Undo (⌘Z)"
            >
              <Undo2 size={14} />
            </button>
            <button
              type="button"
              style={histBtn(!historyRef.current?.canRedo())}
              disabled={!historyRef.current?.canRedo()}
              onClick={() => void applyHistory('redo')}
              title="Redo (⇧⌘Z)"
            >
              <Redo2 size={14} />
            </button>
          </div>
          <DeviceToggle activeBp={activeBp} onChange={setActiveBp} />
          {selectedBlockType?.extension && <button type="button" style={metaBtn(false)} onClick={configureExtensionPreview} title="Set URL values for the Extension preview without saving them">
            URL context
          </button>}
          <button
            type="button"
            style={metaBtn(!selectedId)}
            onClick={() => setSelectedId(null)}
            title="Page metadata — title & SEO"
          >
            <SlidersHorizontal size={14} /> Meta
          </button>
          <PublishMenu
            siteId={siteId}
            pubStatus={draft.status}
            statusOptions={PAGE_STATUS_OPTIONS}
            hasUnsaved={hasWc}
            saving={status === 'saving'}
            onSave={saveAll}
            onDiscard={discardWc}
            onStatusChange={changeStatus}
            docUpdatedAt={draft.date_updated ?? null}
            lastDeployedAt={lastDeployedAt}
            previewUrl={previewUrl}
            liveUrl={liveUrl}
            scheduledPublishAt={draft.publish_at ?? null}
            scheduledUnpublishAt={draft.unpublish_at ?? null}
            onSchedule={changeSchedule}
            onReviewChanges={() => setReviewOpen(true)}
          />
          {reviewOpen && (
            <ReviewChanges
              siteId={siteId}
              pageId={page.id}
              previewUrl={previewUrl}
              onClose={() => setReviewOpen(false)}
            />
          )}
        </div>
      </header>

      <DndContext {...dnd.contextProps}>
      <div style={threeCol}>
        {/* Left panel: tabs + content */}
        <aside style={leftPanel}>
          <div style={tabBar}>
            <button
              type="button"
              style={tabBtn(leftTab === 'add')}
              onClick={() => setLeftTab('add')}
            >
              <Plus size={14} /> Add
            </button>
            <button
              type="button"
              style={tabBtn(leftTab === 'structure')}
              onClick={() => setLeftTab('structure')}
            >
              <GripVertical size={14} /> Structure
            </button>
          </div>
          <div style={leftBody}>
            {leftTab === 'add' && (
              <BlockLibrary
                registry={registry}
                customTypes={customTypes}
                onAdd={(typeId) => {
                  if (selected?.block.children !== undefined || selected?.block.slots !== undefined) {
                    handleAddBlock(typeId, selected.block.id, 0);
                  } else {
                    handleAddBlock(typeId);
                  }
                }}
              />
            )}
            {leftTab === 'structure' && (
              <BlockTree
                blocks={draft.blocks ?? []}
                selectedId={selectedId}
                onSelect={setSelectedId}
                onRemove={handleRemove}
                onDuplicate={handleDuplicate}
                onRename={handleRename}
                registry={registry}
                dropTarget={dnd.dropTarget}
              />
            )}
          </div>
        </aside>

        {/* Center: preview */}
        <main ref={centerRef} style={centerPanel}>
          <div style={frameOuter}>
            <div style={{
              width: typeof frameW === 'number' ? `${frameW}px` : frameW,
              height: typeof frameH === 'number' ? `${frameH}px` : frameH,
              flex: '0 0 auto',
              transform: previewScale < 1 ? `scale(${previewScale})` : undefined,
              transformOrigin: 'top center',
              border: '1px solid #2a2a30', borderRadius: 8, overflow: 'hidden', background: '#fff',
            }}>
              <iframe
                ref={iframeRef}
                src={previewUrl + (previewUrl.includes('?') ? '&' : '?') + `embed=1&interactive=1&canvas=${encodeURIComponent(canvasId)}`}
                title="Preview"
                style={{ width: '100%', height: '100%', border: 'none' }}
              />
            </div>
          </div>
        </main>

        {/* Right: field form */}
        <aside style={rightPanel}>
          {selected ? (
            <BlockFieldForm
              siteId={siteId}
              block={selected.block}
              blockType={registry.get(selected.block.type) ?? null}
              activeBp={activeBp}
              onChange={(data) => handleUpdateData(selected.block.id, data)}
            />
          ) : (
            <MetaPanel
              siteId={siteId}
              page={page}
              draft={draft}
              onChange={updateMeta}
            />
          )}
        </aside>
      </div>
        <DragOverlay dropAnimation={null}>{dnd.overlay}</DragOverlay>
      </DndContext>
    </div>
  );
}

// ─── Block library ──────────────────────────────────────────────────────

export function BlockLibrary({
  registry,
  customTypes,
  onAdd,
}: {
  registry: Map<string, BlockType>;
  customTypes: BlockType[];
  onAdd: (typeId: string) => void;
}) {
  const [filter, setFilter] = useState('');
  const grouped = useMemo(() => {
    const m: Record<string, BlockType[]> = { layout: [], content: [], media: [], custom: [] };
    for (const bt of registry.values()) {
      if (bt.id === 'template_content_slot') continue; // Hide reserved type
      if (filter && !bt.label.toLowerCase().includes(filter.toLowerCase())) continue;
      const cat = customTypes.find((c) => c.id === bt.id) ? 'custom' : bt.category;
      (m[cat] ||= []).push(bt);
    }
    return m;
  }, [registry, customTypes, filter]);

  return (
    <div>
      <input
        type="search"
        placeholder="Search blocks…"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        style={searchInput}
      />
      {(['layout', 'content', 'media', 'custom'] as const).map((cat) => {
        const items = grouped[cat] ?? [];
        if (!items.length) return null;
        return (
          <div key={cat} style={{ marginTop: '1rem' }}>
            <h4 style={catHeading}>{cat}</h4>
            <div style={libraryGrid}>
              {items.map((bt) => (
                <LibraryCard key={bt.id} bt={bt} onAdd={onAdd} />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// A library entry: click to append, or drag onto the tree to place it at a
// precise spot (the shared DndContext + drop-line handle the positioning).
function LibraryCard({ bt, onAdd }: { bt: BlockType; onAdd: (typeId: string) => void }) {
  const Icon = ICONS[bt.name] ?? Square;
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `lib:${bt.id}`,
    data: { kind: 'new', typeId: bt.id },
  });
  return (
    <button
      ref={setNodeRef}
      type="button"
      onClick={() => onAdd(bt.id)}
      style={{ ...libraryCard, opacity: isDragging ? 0.4 : 1, touchAction: 'none' }}
      title={`Add ${bt.label} — or drag it where you want it`}
      {...attributes}
      {...listeners}
    >
      <Icon size={20} />
      <span style={{ fontSize: '.8rem' }}>{bt.label}</span>
    </button>
  );
}

// ─── Block tree (Structure) ──────────────────────────────────────────────

// Cross-parent / cross-slot DnD: the parent editor owns ONE DndContext
// (spanning the library + the tree). Each list here (top level, children of
// a container, contents of a slot) gets:
//   - a stable `containerId` string encoding the destination
//   - a `useDroppable` so the empty area is a valid drop target
//   - a SortableContext with the item ids + the containerId itself
//     (so empty lists are still droppable — sortable items pluralise)
//   - a colored drop-line at `dropTarget.index` while a drag hovers it
//
// containerId grammar:
//   "root"                                — top-level page blocks
//   "block:{blockId}:children"            — container's children list
//   "block:{blockId}:slot:{slotIdx}"      — slot N of a slot-container

type TreeCtx = {
  selectedId: string | null;
  onSelect: (id: string) => void;
  onRemove: (id: string) => void;
  onDuplicate: (id: string) => void;
  onRename: (id: string, name: string) => void;
  registry: Map<string, BlockType>;
  /** Live drop position from the parent's drag handlers; null when idle. */
  dropTarget: DropTarget | null;
};

export function BlockTree({
  blocks, selectedId, onSelect, onRemove, onDuplicate, onRename, registry, dropTarget,
}: {
  blocks: Block[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onRemove: (id: string) => void;
  onDuplicate: (id: string) => void;
  onRename: (id: string, name: string) => void;
  registry: Map<string, BlockType>;
  dropTarget: DropTarget | null;
}) {
  const ctx: TreeCtx = { selectedId, onSelect, onRemove, onDuplicate, onRename, registry, dropTarget };

  // Empty page: still render the (droppable) root list so a block dragged
  // from the library has a landing zone, with a hint above it.
  if (!blocks.length) {
    return (
      <div>
        <div style={emptyHint}>
          <p style={{ marginTop: 0 }}>This page is empty.</p>
          <p style={{ fontSize: '.85rem', opacity: 0.7 }}>
            Drag a block here from <strong>Add</strong> — or click one to append it.
          </p>
        </div>
        <SortableList containerId="root" blocks={[]} depth={0} ctx={ctx} />
      </div>
    );
  }

  return <SortableList containerId="root" blocks={blocks} depth={0} ctx={ctx} />;
}

function SortableList({
  containerId, blocks, depth, ctx,
}: {
  containerId: string;
  blocks: Block[];
  depth: number;
  ctx: TreeCtx;
}) {
  const droppable = useDroppable({ id: containerId, data: { containerId } });
  // Include the containerId in items so the empty area is droppable
  // (SortableContext only treats listed items as drop targets).
  const items = [...blocks.map((b) => b.id), containerId];

  // The gap this list should draw its drop-line at (null = not the active
  // target). `index` is a between-items position: 0..blocks.length.
  const gap = ctx.dropTarget && ctx.dropTarget.containerId === containerId
    ? ctx.dropTarget.index
    : null;

  return (
    <SortableContext items={items} strategy={verticalListSortingStrategy}>
      <ul
        ref={droppable.setNodeRef}
        style={{
          ...treeList,
          marginLeft: depth > 0 ? 8 : 0,
          minHeight: blocks.length === 0 ? 40 : undefined,
          background: droppable.isOver ? 'rgba(99, 102, 241, 0.08)' : 'transparent',
          borderRadius: 4,
          transition: 'background 0.1s',
        }}
      >
        {blocks.length === 0 && gap === null && (
          <li style={emptyDropHint}>
            Drop block here
          </li>
        )}
        {blocks.map((b, i) => (
          <Fragment key={b.id}>
            {gap === i && <DropLine />}
            <SortableBlockNode
              block={b}
              depth={depth}
              containerId={containerId}
              ctx={ctx}
            />
          </Fragment>
        ))}
        {gap === blocks.length && <DropLine />}
      </ul>
    </SortableContext>
  );
}

// The colored insertion marker: a 2px indigo bar drawn in the gap where the
// dragged block will land. Rendered as a non-interactive list item so it
// doesn't register as a sortable/droppable of its own.
function DropLine() {
  return <li aria-hidden style={dropLine} />;
}

function SortableBlockNode({
  block, depth, containerId, ctx,
}: {
  block: Block;
  depth: number;
  containerId: string;
  ctx: TreeCtx;
}) {
  const sortable = useSortable({ id: block.id, data: { containerId } });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(sortable.transform),
    transition: sortable.transition,
    opacity: sortable.isDragging ? 0.4 : 1,
  };
  return (
    <li ref={sortable.setNodeRef} style={style}>
      <BlockNodeInner
        block={block}
        depth={depth}
        ctx={ctx}
        dragHandleProps={{ ...sortable.attributes, ...sortable.listeners }}
      />
    </li>
  );
}

function BlockNodeInner({
  block, depth, ctx, dragHandleProps,
}: {
  block: Block;
  depth: number;
  ctx: TreeCtx;
  dragHandleProps?: React.HTMLAttributes<HTMLElement>;
}) {
  const { selectedId, onSelect, onRemove, onDuplicate, onRename, registry } = ctx;
  const [open, setOpen] = useState(true);
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const bt = registry.get(block.type);
  const Icon = bt ? (ICONS[bt.name] ?? Square) : Square;
  const isSelected = selectedId === block.id;
  const hasChildren = bt?.container === true || bt?.container === false && (block.children?.length ?? 0) > 0;
  const isContainer = bt?.container === true;
  const isSlotContainer = bt?.container === 'slots';
  const expandable = isContainer || isSlotContainer
    || (block.children?.length ?? 0) > 0 || (block.slots?.length ?? 0) > 0;
  void hasChildren;

  // Row label priority: a user-given name (double-click to rename) wins;
  // otherwise the block's own content (heading/prose text, button label, image
  // filename, …) — the icon already conveys the type; otherwise the type label
  // for content-less blocks (sections, grids, columns). The fallback reads
  // muted+italic to signal "no content / name yet".
  const summary = blockSummary(block);
  const rowLabel = block.name || summary || bt?.label || block.type;
  const derivedTypeOnly = !block.name && !summary;

  function startRename(): void {
    setNameDraft(block.name ?? '');
    setRenaming(true);
  }
  function commitRename(): void {
    onRename(block.id, nameDraft);
    setRenaming(false);
  }

  return (
    <>
      <div
        style={treeRow(isSelected, depth)}
        onClick={() => onSelect(block.id)}
      >
        <span {...dragHandleProps} style={dragHandle} title="Drag to move">
          <GripVertical size={12} />
        </span>
        {expandable ? (
          <button type="button" style={chevron} onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}>
            {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </button>
        ) : <span style={{ width: 16 }} />}
        <Icon size={14} />
        {renaming ? (
          <input
            autoFocus
            value={nameDraft}
            placeholder={summary || bt?.label || block.type}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => setNameDraft(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); commitRename(); }
              else if (e.key === 'Escape') { e.preventDefault(); setRenaming(false); }
            }}
            style={renameInput}
          />
        ) : (
          <span
            title={`${rowLabel} — double-click to rename`}
            onDoubleClick={(e) => { e.stopPropagation(); startRename(); }}
            style={{
              flex: 1, fontSize: '.85rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              fontStyle: derivedTypeOnly ? 'italic' : 'normal', opacity: derivedTypeOnly ? 0.7 : 1,
            }}
          >
            {rowLabel}
          </span>
        )}
        <button
          type="button"
          style={iconBtn}
          onClick={(e) => { e.stopPropagation(); onDuplicate(block.id); }}
          title="Duplicate (⌘D)"
        >
          <Copy size={12} />
        </button>
        <button
          type="button"
          style={iconBtn}
          onClick={(e) => { e.stopPropagation(); onRemove(block.id); }}
          title="Delete"
        >
          <Trash2 size={12} />
        </button>
      </div>
      {open && isContainer && (
        <SortableList
          containerId={`block:${block.id}:children`}
          blocks={block.children ?? []}
          depth={depth + 1}
          ctx={ctx}
        />
      )}
      {open && isSlotContainer && (
        <div style={{ marginLeft: 8 }}>
          {(block.slots ?? Array.from({ length: bt?.slot_count ?? 0 }, () => [])).map((slot, slotIdx) => (
            <div key={slotIdx} style={{ marginTop: 4 }}>
              <div style={slotLabel}>{bt?.slot_labels?.[slotIdx] ?? `Slot ${slotIdx + 1}`}</div>
              <SortableList
                containerId={`block:${block.id}:slot:${slotIdx}`}
                blocks={slot}
                depth={depth + 1}
                ctx={ctx}
              />
            </div>
          ))}
        </div>
      )}
    </>
  );
}

// ─── Field form ─────────────────────────────────────────────────────────

/**
 * Merge a single-breakpoint edit into a responsive field value.
 *
 * `raw` is the stored value (scalar = "applies everywhere", or a sparse
 * mobile-first object). Editing at `bp` writes that breakpoint; an empty
 * value clears the override. The result collapses back to a scalar when only
 * `mobile` survives, and to `undefined` when nothing is left (caller then
 * falls back to the schema default so the field doesn't go blank).
 */
function mergeResponsive(raw: unknown, bp: Breakpoint, value: unknown): unknown {
  const obj: Partial<Record<Breakpoint, unknown>> = isResponsiveValue(raw)
    ? { ...(raw as Partial<Record<Breakpoint, unknown>>) }
    : raw === undefined || raw === null || raw === ''
      ? {}
      : { mobile: raw };

  const isEmpty = value === undefined || value === null || value === '';
  if (isEmpty) delete obj[bp];
  else obj[bp] = value;

  const keys = Object.keys(obj) as Breakpoint[];
  if (keys.length === 0) return undefined;
  if (keys.length === 1 && keys[0] === 'mobile') return obj.mobile;
  return obj;
}

// ─── Meta panel ─────────────────────────────────────────────────────────
// Shown in the right rail when no block is selected (and reachable any time
// via the "Meta" button in the top bar). Holds page-level metadata — title,
// SEO, template, content mode — so block-mode pages can edit their title/SEO
// without leaving the editor. Saves are debounced by the parent's updateMeta.
function MetaPanel({
  siteId, page, draft, onChange,
}: {
  siteId: string;
  page: Page;
  draft: Page;
  onChange: <K extends keyof Page>(key: K, value: Page[K]) => void;
}) {
  return (
    <div>
      <h3 style={{ margin: '0 0 0.25rem', fontSize: '0.95rem', color: '#fafafa' }}>Page metadata</h3>
      <p style={{ margin: '0 0 1rem', fontSize: '.8rem', color: '#a1a1aa' }}>
        Title &amp; SEO for the whole page. Select a block to edit its content.
      </p>

      <p style={{ margin: '0 0 1rem', fontSize: '.72rem', color: '#a1a1aa' }}>
        Status, saving and deploy live under the <strong>Publish</strong> button, top right.
      </p>

      <div style={fieldGroup}>
        <label style={fieldLabel}>Page title</label>
        <input
          style={textInput}
          value={draft.title ?? ''}
          onChange={(e) => onChange('title', e.target.value)}
          placeholder="Page name"
        />
      </div>

      <div style={fieldGroup}>
        <label style={fieldLabel}>SEO title</label>
        <input
          style={textInput}
          value={draft.seo_title ?? ''}
          onChange={(e) => onChange('seo_title', e.target.value)}
          placeholder={draft.title || 'Falls back to the page title'}
        />
      </div>

      <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', margin: '0.25rem 0 1rem', color: '#d4d4d8', fontSize: '.85rem', cursor: 'pointer' }}>
        <input
          type="checkbox"
          checked={draft.append_seo_suffix !== false}
          onChange={(e) => onChange('append_seo_suffix', e.target.checked)}
        />
        Append the site SEO suffix
      </label>

      <div style={fieldGroup}>
        <label style={fieldLabel}>Meta description</label>
        <textarea
          style={{ ...textareaInput, minHeight: '4.5rem' }}
          value={draft.seo_description ?? ''}
          onChange={(e) => onChange('seo_description', e.target.value)}
          placeholder="Short description for search results & sharing"
        />
      </div>

      <div style={fieldGroup}>
        <label style={fieldLabel}>OG image (URL)</label>
        <input
          style={textInput}
          value={draft.og_image ?? ''}
          onChange={(e) => onChange('og_image', e.target.value)}
          placeholder="https://…"
        />
      </div>

      <div style={fieldGroup}>
        <label style={fieldLabel}>OG image alt text</label>
        <input
          style={textInput}
          value={draft.seo_image_alt ?? ''}
          onChange={(e) => onChange('seo_image_alt', e.target.value)}
          placeholder="Description of the sharing image"
        />
      </div>

      <div style={fieldGroup}>
        <label style={fieldLabel}>Canonical URL</label>
        <input
          style={textInput}
          value={draft.canonical_url ?? ''}
          onChange={(e) => onChange('canonical_url', e.target.value)}
          placeholder="Leave empty for the default"
        />
      </div>

      <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', margin: '0.25rem 0 1rem', color: '#d4d4d8', fontSize: '.85rem', cursor: 'pointer' }}>
        <input
          type="checkbox"
          checked={!!draft.noindex}
          onChange={(e) => onChange('noindex', e.target.checked)}
        />
        Hide from search engines (noindex)
      </label>

      <div style={{ borderTop: '1px solid #2a2a30', paddingTop: '0.85rem' }}>
        <TemplatePicker siteId={siteId} pageId={page.id} currentTemplate={draft.template} />
        <ContentModeSwitcher siteId={siteId} pageId={page.id} currentMode="blocks" />
      </div>
    </div>
  );
}

export function BlockFieldForm({
  siteId, block, blockType, activeBp = DEFAULT_BP, onChange,
}: {
  siteId?: string;
  block: Block;
  blockType: BlockType | null;
  activeBp?: Breakpoint;
  onChange: (data: Record<string, unknown>) => void;
}) {
  const [local, setLocal] = useState<Record<string, unknown>>(block.data ?? {});
  const saveTimer = useRef<number | null>(null);

  useEffect(() => {
    setLocal(block.data ?? {});
  }, [block.id]);

  function commit(field: string, storedValue: unknown) {
    const next = { ...local, [field]: storedValue };
    setLocal(next);
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      // null clears the field server-side; the PATCH merges shallowly so a
      // single-field body is enough.
      onChange({ [field]: storedValue === undefined ? null : storedValue });
    }, 600);
  }

  function set(fieldName: string, value: unknown, responsive: boolean, fallback: unknown) {
    if (!responsive) {
      commit(fieldName, value);
      return;
    }
    const merged = mergeResponsive(local[fieldName], activeBp, value);
    commit(fieldName, merged === undefined ? fallback : merged);
  }

  if (!blockType) {
    return (
      <div>
        <h3 style={{ marginTop: 0 }}>{block.type}</h3>
        <p style={{ fontSize: '.85rem', opacity: 0.7 }}>
          Unknown block type — install the package or create it as a custom block.
        </p>
      </div>
    );
  }

  return (
    <div>
      <h3 style={{ marginTop: 0, fontSize: '0.95rem' }}>{blockType.label}</h3>
      <p style={{ fontSize: '.75rem', opacity: 0.6, marginTop: '-0.5rem' }}>{blockType.id}</p>
      <form onSubmit={(e) => e.preventDefault()}>
        {blockType.schema.map((f) => {
          const raw = local[f.name];
          const responsive = !!(f as { responsive?: boolean }).responsive;
          // The input shows the value resolved at the active breakpoint;
          // `hasOwn` marks whether THIS breakpoint sets it explicitly (vs.
          // inheriting a smaller breakpoint's value).
          const value = responsive ? resolveResponsive(raw, activeBp) : raw;
          const hasOwn = responsive && isResponsiveValue(raw)
            && (raw as Partial<Record<Breakpoint, unknown>>)[activeBp] !== undefined;
          return (
            <FieldInput
              key={f.name}
              siteId={siteId}
              field={f}
              value={value}
              responsive={responsive}
              activeBp={activeBp}
              hasOwn={hasOwn}
              onChange={(v) => set(f.name, v, responsive, f.default)}
            />
          );
        })}
      </form>
    </div>
  );
}

function FieldInput({
  siteId, field, value, onChange, responsive, activeBp, hasOwn,
}: {
  siteId?: string;
  field: FieldDefinition;
  value: unknown;
  onChange: (v: unknown) => void;
  responsive?: boolean;
  activeBp?: Breakpoint;
  hasOwn?: boolean;
}) {
  const label = (
    <label style={fieldLabel}>
      {field.label}
      {responsive && activeBp && (
        <ResponsiveBadge activeBp={activeBp} hasOwn={!!hasOwn} onReset={() => onChange('')} />
      )}
    </label>
  );
  const v = (value ?? '') as string;
  switch (field.type) {
    case 'textarea':
    case 'richtext': {
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
          <textarea
            rows={isCode ? 24 : field.type === 'richtext' ? 8 : 4}
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
          <select value={v} onChange={(e) => onChange(e.target.value)} style={selectInput}>
            {(field.options ?? []).map((opt, index) => (
              <option key={opt} value={opt}>{field.option_labels?.[index] ?? opt}</option>
            ))}
          </select>
        </div>
      );
    case 'boolean':
      return (
        <div style={fieldGroup}>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: '.85rem' }}>
            <input
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
          <input type="color" value={v || '#000000'} onChange={(e) => onChange(e.target.value)} />
        </div>
      );
    case 'number':
      return (
        <div style={fieldGroup}>
          {label}
          <input
            type="number"
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
          <textarea
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
          field={field}
          value={Array.isArray(value) ? value : []}
          onChange={onChange}
          label={label}
        />
      );
    case 'object':
      return (
        <ObjectFieldInput
          siteId={siteId}
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
          <input
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

function ObjectFieldInput({
  siteId, field, value, onChange, label,
}: {
  siteId?: string;
  field: FieldDefinition;
  value: Record<string, unknown>;
  onChange: (value: unknown) => void;
  label: React.ReactNode;
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
          field={child}
          value={value[child.name]}
          onChange={(next) => onChange({ ...value, [child.name]: next })}
        />
      ))}
    </fieldset>
  );
}

function ArrayFieldInput({
  siteId, field, value, onChange, label,
}: {
  siteId?: string;
  field: FieldDefinition;
  value: unknown[];
  onChange: (value: unknown) => void;
  label: React.ReactNode;
}) {
  const children = field.fields ?? [];
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
      <button type="button" onClick={() => onChange([...value, {}])} style={smallActionBtn}>+ Add item</button>
    </fieldset>
  );
}

function JsonFieldInput({
  value, onChange, label, expected,
}: {
  value: unknown;
  onChange: (value: unknown) => void;
  label: React.ReactNode;
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
  siteId, field, value, onChange, label,
}: {
  siteId?: string;
  field: FieldDefinition;
  value: string;
  onChange: (value: unknown) => void;
  label: React.ReactNode;
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
    <span style={respBadge} title={`Value for ${label}. Switch screen size in the header to set other breakpoints.`}>
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

// ─── Device toggle ──────────────────────────────────────────────────────

// Five presets mapped onto the five responsive breakpoints. Selecting one
// drives the preview width AND the active editing breakpoint for responsive
// fields (e.g. grid columns).
export function DeviceToggle({ activeBp, onChange }: { activeBp: Breakpoint; onChange: (bp: Breakpoint) => void }) {
  return (
    <div style={{ display: 'flex', gap: 4, border: '1px solid #2a2a30', borderRadius: 6, padding: 2 }}>
      {DEVICES.map((d) => {
        const Icon = d.icon;
        return (
          <button
            key={d.bp}
            type="button"
            onClick={() => onChange(d.bp)}
            style={deviceBtn(activeBp === d.bp)}
            title={`${d.label} — ${BREAKPOINTS[d.bp].label}`}
          >
            <span style={{ display: 'inline-flex', transform: d.landscape ? 'rotate(90deg)' : undefined }}>
              <Icon size={14} />
            </span>
          </button>
        );
      })}
    </div>
  );
}

// ─── Tree helpers (client-side mirror of lib/block-mutations) ───────────

// ─── Tree row label ─────────────────────────────────────────────────────

/** Resolve a field value to a display string. Responsive objects collapse to
 *  their effective (mobile-first) value; non-strings are ignored. */
function fieldText(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    for (const bp of ['mobile', 'tablet', 'laptop', 'desktop', 'wide']) {
      if (typeof o[bp] === 'string') return o[bp] as string;
    }
  }
  return '';
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
}

function fileName(url: string): string {
  const clean = url.split(/[?#]/)[0]!.replace(/\/+$/, '');
  const base = clean.slice(clean.lastIndexOf('/') + 1);
  return base || url;
}

/**
 * Derive a content summary for a block to show in the Structure tree instead of
 * the block-type name (the icon already conveys the type). Images show their
 * filename; text-bearing blocks show their text. Returns '' for content-less
 * blocks (sections, grids, columns), where the caller falls back to the label.
 */
function blockSummary(block: Block): string {
  const data = (block.data ?? {}) as Record<string, unknown>;

  // Image-ish fields → filename.
  for (const k of ['src', 'image', 'background_image']) {
    const s = fieldText(data[k]);
    if (s && (k === 'src' || /\.(png|jpe?g|gif|webp|avif|svg)(\?|#|$)/i.test(s))) {
      return fileName(s);
    }
  }

  // Text-bearing fields, most-specific first.
  for (const k of [
    'text', 'heading', 'title', 'label', 'primary_label', 'quote',
    'caption', 'name', 'content', 'html', 'prose', 'body', 'alt',
  ]) {
    let s = fieldText(data[k]);
    if (!s) continue;
    if (/<[a-z!/][\s\S]*>/i.test(s)) s = stripHtml(s);
    s = s.trim();
    if (s) return s.length > 80 ? `${s.slice(0, 80)}…` : s;
  }
  return '';
}

function findBlock(blocks: Block[], id: string): { block: Block; parent: Block | null } | null {
  for (const b of blocks) {
    if (b.id === id) return { block: b, parent: null };
    if (b.children) {
      for (const c of b.children) {
        if (c.id === id) return { block: c, parent: b };
        const deep = findBlock([c], id);
        if (deep) return deep;
      }
    }
    if (b.slots) {
      for (const slot of b.slots) {
        for (const c of slot) {
          if (c.id === id) return { block: c, parent: b };
          const deep = findBlock([c], id);
          if (deep) return deep;
        }
      }
    }
  }
  return null;
}

// ─── Empty-block placeholders (editor preview only) ─────────────────────
// A block with no content yet — a freshly dragged-in heading, an empty
// container — renders to nothing and is invisible + un-clickable. In the
// editor preview we tag such blocks with a `data-empty-label` and a ghost
// label so they're visible and selectable; nothing is persisted, so the live
// site never shows placeholder text.

// Field types whose emptiness would leave a block with nothing visible. Config
// types (select, boolean, color, number, date, refs, object) are excluded —
// they never produce standalone visible content.
const CONTENT_FIELD_TYPES = new Set([
  'text', 'textarea', 'richtext', 'string', 'url', 'email',
  'image', 'media', 'icon', 'array', 'list_simple',
]);

function isEmptyContent(v: unknown): boolean {
  if (v == null) return true;
  if (typeof v === 'string') return stripHtml(v).trim() === '';
  if (Array.isArray(v)) return v.length === 0;
  return false; // objects (e.g. responsive values) → treat as "has a value"
}

/** The ghost label for a block that would render empty, or null when it has
 *  visible content (or isn't a kind we placeholder). */
export function placeholderLabelFor(block: Block, bt: BlockType | undefined): string | null {
  if (!bt) return null;
  // template/* blocks render from render context (page/site/item), not their
  // own data — their fields being empty doesn't mean the output is empty.
  if (bt.id.startsWith('template/')) return null;

  // Containers are empty when they hold no children / slot content.
  if (bt.container === true || bt.container === 'slots') {
    const noChildren = (block.children?.length ?? 0) === 0;
    const noSlots = !block.slots || block.slots.every((s) => s.length === 0);
    return noChildren && noSlots ? bt.label : null;
  }

  // Leaf blocks: empty when EVERY content-bearing field is blank. Requiring
  // *all* of them (not just one) avoids false-flagging a block that has, say, a
  // filled heading but an empty secondary field (a hero with no button label).
  const data = (block.data ?? {}) as Record<string, unknown>;
  const contentFields = (bt.schema ?? []).filter((f) => CONTENT_FIELD_TYPES.has(f.type));
  if (contentFields.length === 0) return null;
  return contentFields.every((f) => isEmptyContent(data[f.name])) ? bt.label : null;
}

function forEachBlock(blocks: Block[], cb: (b: Block) => void): void {
  for (const b of blocks) {
    cb(b);
    if (b.children) forEachBlock(b.children, cb);
    if (b.slots) for (const s of b.slots) forEachBlock(s, cb);
  }
}

// ─── Styles ─────────────────────────────────────────────────────────────

const shell: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', height: '100vh', background: '#0f0f12', color: '#e4e4e7',
};
const topBar: React.CSSProperties = {
  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
  padding: '0.5rem 1rem', borderBottom: '1px solid #2a2a30',
};
const threeCol: React.CSSProperties = {
  display: 'grid', gridTemplateColumns: '280px 1fr 320px', flex: 1, overflow: 'hidden',
};
const leftPanel: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', borderRight: '1px solid #2a2a30', overflow: 'hidden',
};
const tabBar: React.CSSProperties = {
  display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 0, borderBottom: '1px solid #2a2a30',
};
const tabBtn = (active: boolean): React.CSSProperties => ({
  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
  padding: '0.65rem 0.5rem',
  background: active ? '#1f1f23' : 'transparent',
  color: active ? '#fafafa' : '#a1a1aa',
  border: 'none',
  borderBottom: active ? '2px solid #6366f1' : '2px solid transparent',
  cursor: 'pointer',
  fontSize: '.85rem',
});
const leftBody: React.CSSProperties = { flex: 1, overflow: 'auto', padding: '0.75rem' };
const centerPanel: React.CSSProperties = { padding: '1rem', overflow: 'hidden', background: '#0a0a0d' };
const frameOuter: React.CSSProperties = {
  width: '100%', height: '100%', display: 'flex', justifyContent: 'center',
  alignItems: 'flex-start', overflow: 'hidden',
};
const rightPanel: React.CSSProperties = {
  borderLeft: '1px solid #2a2a30', padding: '1rem', overflow: 'auto',
};
const emptyHint: React.CSSProperties = { padding: '1rem', color: '#a1a1aa' };
const metaBtn = (active: boolean): React.CSSProperties => ({
  display: 'inline-flex', alignItems: 'center', gap: 5,
  padding: '0.45rem 0.7rem', borderRadius: 6, cursor: 'pointer', fontSize: '.8rem',
  background: active ? '#1f1f3d' : '#1f1f23',
  color: active ? '#c7d2fe' : '#d4d4d8',
  border: active ? '1px solid #4f46e5' : '1px solid #2a2a30',
});
const histBtn = (disabled: boolean): React.CSSProperties => ({
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  width: 30, height: 30, borderRadius: 6, cursor: disabled ? 'default' : 'pointer',
  background: '#1f1f23', color: disabled ? '#4b4b52' : '#d4d4d8',
  border: '1px solid #2a2a30',
});
const searchInput: React.CSSProperties = {
  width: '100%', padding: '0.4rem 0.6rem', background: '#1f1f23', color: '#fafafa',
  border: '1px solid #2a2a30', borderRadius: 6, fontSize: '.85rem',
};
const catHeading: React.CSSProperties = {
  margin: '0 0 .5rem', textTransform: 'uppercase', fontSize: '.65rem',
  letterSpacing: '0.05em', opacity: 0.55,
};
const libraryGrid: React.CSSProperties = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 };
const libraryCard: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
  padding: '.6rem .4rem', background: '#1a1a1f', border: '1px solid #2a2a30',
  borderRadius: 6, color: '#e4e4e7', cursor: 'pointer',
};
const treeList: React.CSSProperties = { listStyle: 'none', padding: 0, margin: 0 };
const treeRow = (selected: boolean, depth: number): React.CSSProperties => ({
  display: 'flex', alignItems: 'center', gap: 4,
  padding: '.3rem .4rem',
  paddingLeft: `${0.4 + depth * 0.5}rem`,
  background: selected ? '#1f1f3d' : 'transparent',
  borderRadius: 4,
  cursor: 'pointer',
});
const renameInput: React.CSSProperties = {
  flex: 1, minWidth: 0, fontSize: '.85rem',
  padding: '1px 4px', background: '#0f0f12', color: '#fafafa',
  border: '1px solid #6366f1', borderRadius: 4, outline: 'none',
};
const dragHandle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', opacity: 0.5, cursor: 'grab',
};
const chevron: React.CSSProperties = {
  display: 'flex', alignItems: 'center', background: 'none', border: 'none',
  color: '#a1a1aa', cursor: 'pointer', padding: 0,
};
const iconBtn: React.CSSProperties = {
  display: 'flex', alignItems: 'center', background: 'none', border: 'none',
  color: '#a1a1aa', cursor: 'pointer', padding: 2, opacity: 0.6,
};
const slotLabel: React.CSSProperties = {
  fontSize: '.7rem', textTransform: 'uppercase', letterSpacing: '0.05em', opacity: 0.55,
  paddingLeft: '0.5rem', margin: '0.25rem 0',
};
const emptyDropHint: React.CSSProperties = {
  fontSize: '.7rem', color: '#a1a1aa', fontStyle: 'italic',
  padding: '.25rem .5rem', listStyle: 'none',
};
const dropLine: React.CSSProperties = {
  listStyle: 'none', height: 2, margin: '2px 0', padding: 0,
  background: '#6366f1', borderRadius: 2,
  boxShadow: '0 0 4px rgba(99,102,241,0.7)',
};
const fieldGroup: React.CSSProperties = { marginBottom: '0.75rem' };
const fieldLabel: React.CSSProperties = {
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
const textInput: React.CSSProperties = {
  width: '100%', padding: '0.4rem 0.6rem', background: '#1f1f23', color: '#fafafa',
  border: '1px solid #2a2a30', borderRadius: 6, fontSize: '.85rem', boxSizing: 'border-box',
};
const textareaInput: React.CSSProperties = {
  ...textInput, fontFamily: 'ui-monospace, "SF Mono", Consolas, monospace',
  lineHeight: 1.5, resize: 'vertical', minHeight: '5.5rem',
};
const selectInput: React.CSSProperties = textInput;
const smallActionBtn: React.CSSProperties = {
  padding: '0.3rem 0.55rem', fontSize: '.75rem', cursor: 'pointer',
  background: '#1f1f23', color: '#d4d4d8', border: '1px solid #3f3f46', borderRadius: 5,
};
const exitBtn: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 5,
  padding: '0.3rem 0.6rem', fontSize: '.8rem',
  background: '#1f1f23', color: '#e4e4e7', textDecoration: 'none',
  border: '1px solid #2a2a30', borderRadius: 6,
};
const deviceBtn = (active: boolean): React.CSSProperties => ({
  display: 'flex', alignItems: 'center', padding: 4,
  background: active ? '#2a2a30' : 'transparent',
  border: 'none', color: '#e4e4e7', cursor: 'pointer', borderRadius: 4,
});
