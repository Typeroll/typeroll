// Shared drag-and-drop orchestration for the block editors (page + template).
//
// One DndContext spans a block editor's whole left panel — the block library
// AND the structure tree — so a block can be dragged straight from the library
// and dropped at a precise spot in the tree. A colored drop-line (rendered by
// SortableList in BlockPageEditor) tracks the pointer to show where the block
// will land BEFORE the drop.
//
// Both editors share this hook so their drag behaviour can't drift: the page
// editor persists via the /blocks mutation routes, the template editor via a
// whole-tree PATCH, but the gap math + add/move dispatch is identical.

import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { Block, BlockType } from '@typeroll/shared';
import {
  KeyboardSensor, MeasuringStrategy, PointerSensor, pointerWithin, useSensor, useSensors,
  type CollisionDetection, type MeasuringConfiguration,
  type DragStartEvent, type DragMoveEvent, type DragEndEvent,
} from '@dnd-kit/core';
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import { GripVertical, Square } from 'lucide-react';

export type IconCmp = React.ComponentType<{ size?: number }>;

// What the pointer is currently dragging. A library card (`new`) inserts a
// fresh block on drop; a tree node (`existing`) relocates a block.
export type ActiveDrag =
  | { kind: 'new'; typeId: string; label: string; Icon: IconCmp }
  | { kind: 'existing'; blockId: string; label: string };

/** Where the dragged block would land: a container list + the gap index
 *  (0 = before the first child, list.length = after the last). Drives both
 *  the colored drop-line and the eventual add/move call. */
export type DropTarget = { containerId: string; index: number };

// ─── containerId grammar ────────────────────────────────────────────────
//   "root"                            — top-level blocks
//   "block:{blockId}:children"        — a container's children list
//   "block:{blockId}:slot:{slotIdx}"  — slot N of a slot-container

export function isContainerId(id: string): boolean {
  return id === 'root' || id.startsWith('block:');
}

export function parseContainerId(id: string): { parentId: string | null; slotIdx?: number } {
  if (id === 'root') return { parentId: null };
  const slot = id.match(/^block:(.+):slot:(\d+)$/);
  if (slot) return { parentId: slot[1], slotIdx: Number(slot[2]) };
  const ch = id.match(/^block:(.+):children$/);
  if (ch) return { parentId: ch[1] };
  return { parentId: null };
}

/** Resolve a containerId back to the block[] it addresses. */
export function listOf(rootBlocks: Block[], containerId: string): Block[] {
  if (containerId === 'root') return rootBlocks;
  const { parentId, slotIdx } = parseContainerId(containerId);
  if (!parentId) return rootBlocks;
  function find(list: Block[]): Block | null {
    for (const b of list) {
      if (b.id === parentId) return b;
      if (b.children) { const f = find(b.children); if (f) return f; }
      if (b.slots) for (const s of b.slots) { const f = find(s); if (f) return f; }
    }
    return null;
  }
  const parent = find(rootBlocks);
  if (!parent) return [];
  if (slotIdx !== undefined) return parent.slots?.[slotIdx] ?? [];
  return parent.children ?? [];
}

/** Find a block's own container + index in the tree — the inverse of listOf.
 *  Used by canvas hit-testing to map a rendered `data-block-id` element back
 *  to a position (drop as a sibling above/below it). */
export function locateBlock(blocks: Block[], id: string): { containerId: string; index: number } | null {
  function walk(list: Block[], containerId: string): { containerId: string; index: number } | null {
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      if (b.id === id) return { containerId, index: i };
      if (b.children) { const f = walk(b.children, `block:${b.id}:children`); if (f) return f; }
      if (b.slots) {
        for (let s = 0; s < b.slots.length; s++) {
          const f = walk(b.slots[s], `block:${b.id}:slot:${s}`);
          if (f) return f;
        }
      }
    }
    return null;
  }
  return walk(blocks, 'root');
}

/** The concrete mutation a drop resolves to (or null for a no-op drop). */
export type DropAction =
  | { action: 'add'; typeId: string; parentId: string | null; slotIdx: number | undefined; position: number }
  | { action: 'move'; blockId: string; parentId: string | null; slotIdx: number | undefined; position: number };

/**
 * Turn a hovered drop position into an add/move instruction. Pure so the
 * gap→position translation is unit-testable.
 *
 * The drop-line's `index` is a gap in the list as *currently displayed* (for a
 * reorder, the dragged block is still present). A move removes the block first
 * and then re-inserts, so when the source sits before the gap in the SAME
 * container the post-removal position shifts down by one. Dropping into the
 * source's own slot (the gap immediately before or after it) is a no-op.
 */
export function resolveDrop(blocks: Block[], drag: ActiveDrag, target: DropTarget): DropAction | null {
  const { parentId, slotIdx } = parseContainerId(target.containerId);
  if (drag.kind === 'new') {
    return { action: 'add', typeId: drag.typeId, parentId, slotIdx, position: target.index };
  }
  const list = listOf(blocks, target.containerId);
  const srcIdx = list.findIndex((b) => b.id === drag.blockId);
  let position = target.index;
  if (srcIdx >= 0) {
    if (target.index === srcIdx || target.index === srcIdx + 1) return null;
    if (srcIdx < target.index) position = target.index - 1;
  }
  return { action: 'move', blockId: drag.blockId, parentId, slotIdx, position };
}

export interface UseBlockDndOptions {
  /** Current tree, read fresh each render so gap math sees live positions. */
  blocks: Block[];
  registry: Map<string, BlockType>;
  /** Icon lookup by BlockType.name (editor-owned so the overlay matches). */
  icons: Record<string, IconCmp>;
  /** Insert a fresh block of `typeId` at the resolved container + position. */
  onAdd: (typeId: string, parentId: string | null, slotIdx: number | undefined, position: number) => void;
  /** Relocate an existing block to the resolved container + position. */
  onMove: (blockId: string, parentId: string | null, slotIdx: number | undefined, position: number) => void;
  /** Fired when a library card starts dragging — e.g. reveal the tree tab. */
  onNewDragStart?: () => void;
  /**
   * Enables dropping onto the live preview canvas (an annotated same-origin
   * iframe). While dragging, the iframe is made pointer-transparent so the
   * parent's dnd-kit keeps tracking; the pointer is hit-tested against the
   * rendered blocks (via `data-block-id`) to place the drop, and a matching
   * drop-line is drawn INSIDE the iframe. Omit for editors without a preview
   * (e.g. the template editor).
   */
  canvas?: {
    getIframe: () => HTMLIFrameElement | null;
    /** Current CSS zoom of the preview frame (device presets scale it down). */
    getScale: () => number;
    /** Latest geometry snapshot reported by the opaque-origin canvas. */
    getGeometry: () => CanvasGeometry | null;
    /** Sends a visual-only command through the editor canvas bridge. */
    sendCommand: (command: Record<string, unknown>) => void;
  };
}

export interface CanvasGeometry {
  blocks: Array<{ id: string; left: number; top: number; width: number; height: number }>;
  body: { left: number; top: number; width: number; height: number };
}

export interface UseBlockDnd {
  sensors: ReturnType<typeof useSensors>;
  activeDrag: ActiveDrag | null;
  dropTarget: DropTarget | null;
  /** Spread onto <DndContext>. */
  contextProps: {
    sensors: ReturnType<typeof useSensors>;
    collisionDetection: CollisionDetection;
    measuring: MeasuringConfiguration;
    onDragStart: (e: DragStartEvent) => void;
    onDragMove: (e: DragMoveEvent) => void;
    onDragEnd: (e: DragEndEvent) => void;
    onDragCancel: () => void;
  };
  /** Content for <DragOverlay> — the floating label under the cursor. */
  overlay: ReactNode;
}

export function useBlockDnd(opts: UseBlockDndOptions): UseBlockDnd {
  const { blocks, registry, icons, onAdd, onMove, onNewDragStart, canvas } = opts;

  const [activeDrag, setActiveDrag] = useState<ActiveDrag | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);

  // Live pointer coords: decide a hovered node's above/below gap, and hit-test
  // the preview canvas. Kept in refs so onDragMove reads them without re-subs.
  const pointerXRef = useRef<number | null>(null);
  const pointerYRef = useRef<number | null>(null);
  useEffect(() => {
    const onMovePtr = (e: PointerEvent) => { pointerXRef.current = e.clientX; pointerYRef.current = e.clientY; };
    window.addEventListener('pointermove', onMovePtr, { passive: true });
    return () => window.removeEventListener('pointermove', onMovePtr);
  }, []);

  // The canvas is opaque-origin. Geometry and visual commands travel over
  // the editor bridge; only the iframe element itself is touched here.
  const savedPointerEventsRef = useRef<string>('');

  function setTarget(containerId: string, index: number): void {
    setDropTarget((prev) =>
      prev && prev.containerId === containerId && prev.index === index ? prev : { containerId, index });
  }

  function drawIndicator(r: { left: number; top: number; width: number; height: number }, below: boolean): void {
    const y = below ? r.top + r.height : r.top;
    canvas?.sendCommand({ action: 'indicator', rect: { left: r.left, top: y, width: r.width } });
  }
  function hideIndicator(): void {
    canvas?.sendCommand({ action: 'indicator', rect: null });
  }

  /** Hit-test the preview canvas under the pointer. Returns true when it set a
   *  drop target (and drew the indicator). */
  function canvasHitTest(): boolean {
    if (!canvas) return false;
    const iframe = canvas.getIframe();
    const geometry = canvas.getGeometry();
    if (!iframe || !geometry) return false;
    const px = pointerXRef.current, py = pointerYRef.current;
    if (px == null || py == null) return false;
    const rect = iframe.getBoundingClientRect();
    if (px < rect.left || px > rect.right || py < rect.top || py > rect.bottom) return false;

    // The frame is CSS-scaled on screen; its internal coordinates are not.
    const scale = canvas.getScale() || 1;
    const lx = (px - rect.left) / scale;
    const ly = (py - rect.top) / scale;

    // Pick the smallest reported annotated box under the pointer that maps
    // to a real tree block. Synthetic repeater ids simply fail locateBlock.
    const candidates = geometry.blocks
      .filter((box) => lx >= box.left && lx <= box.left + box.width && ly >= box.top && ly <= box.top + box.height)
      .sort((a, b) => a.width * a.height - b.width * b.height);
    for (const box of candidates) {
      const loc = locateBlock(blocks, box.id);
      if (!loc) continue;
      const below = ly > box.top + box.height / 2;
      setTarget(loc.containerId, below ? loc.index + 1 : loc.index);
      drawIndicator(box, below);
      return true;
    }
    // Empty page (nothing to hover) → drop at the top of the root.
    if ((blocks?.length ?? 0) === 0) {
      const r = geometry.body;
      setTarget('root', 0);
      drawIndicator({ left: r.left + 12, top: r.top + 12, width: Math.min(r.width - 24, 640), height: 0 }, false);
      return true;
    }
    return false;
  }

  const sensors = useSensors(
    // A few px of travel before a drag starts, so a plain click on a library
    // card still appends instead of being swallowed by the drag.
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function onDragStart(e: DragStartEvent): void {
    const data = e.active.data.current as { kind?: string; typeId?: string } | undefined;
    if (data?.kind === 'new' && data.typeId) {
      const bt = registry.get(data.typeId);
      const fallbackIcon = Square as IconCmp;
      const Icon = bt ? (icons[bt.name] ?? fallbackIcon) : fallbackIcon;
      setActiveDrag({ kind: 'new', typeId: data.typeId, label: bt?.label ?? data.typeId, Icon });
      onNewDragStart?.();
    } else {
      const blockId = String(e.active.id);
      const found = findBlock(blocks, blockId);
      const label = found
        ? (found.name || registry.get(found.type)?.label || found.type)
        : blockId;
      setActiveDrag({ kind: 'existing', blockId, label });
    }
    // Make the preview pointer-transparent so events flow to dnd-kit in the
    // parent while the pointer is over the canvas; we hit-test it ourselves.
    const iframe = canvas?.getIframe();
    if (iframe) { savedPointerEventsRef.current = iframe.style.pointerEvents; iframe.style.pointerEvents = 'none'; }
  }

  function onDragMove(e: DragMoveEvent): void {
    const { over } = e;
    // Tree path: dnd-kit resolved a droppable list under the pointer.
    if (over) {
      const overId = String(over.id);
      const overData = over.data.current as { containerId?: string } | undefined;
      const containerId = overData?.containerId ?? (isContainerId(overId) ? overId : null);
      if (containerId) {
        hideIndicator();
        const list = listOf(blocks, containerId);
        let index: number;
        if (overId === containerId) {
          index = list.length; // container's own droppable area
        } else {
          const overIdx = list.findIndex((b) => b.id === overId);
          if (overIdx < 0) {
            index = list.length;
          } else {
            const mid = over.rect.top + over.rect.height / 2;
            const y = pointerYRef.current;
            index = y != null && y > mid ? overIdx + 1 : overIdx;
          }
        }
        setTarget(containerId, index);
        return;
      }
    }
    // Canvas path: pointer is over the preview, not a tree list.
    if (canvasHitTest()) return;
    hideIndicator();
    setDropTarget(null);
  }

  function endDrag(): void {
    setActiveDrag(null);
    setDropTarget(null);
    hideIndicator();
    const iframe = canvas?.getIframe();
    if (iframe) iframe.style.pointerEvents = savedPointerEventsRef.current;
  }

  function onDragEnd(): void {
    const drag = activeDrag;
    const target = dropTarget;
    endDrag();
    if (!drag || !target) return;
    const action = resolveDrop(blocks, drag, target);
    if (!action) return;
    if (action.action === 'add') onAdd(action.typeId, action.parentId, action.slotIdx, action.position);
    else onMove(action.blockId, action.parentId, action.slotIdx, action.position);
  }

  const overlay: ReactNode = activeDrag ? (
    <div style={dragOverlayPill}>
      {activeDrag.kind === 'new'
        ? <activeDrag.Icon size={14} />
        : <GripVertical size={12} />}
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {activeDrag.label}
      </span>
    </div>
  ) : null;

  return {
    sensors,
    activeDrag,
    dropTarget,
    // pointerWithin resolves `over` from the pointer position, not the active
    // node's rect — essential because a library card unmounts on drag start
    // (its tab switches away), which would leave a rect-based detector blind.
    // MeasuringStrategy.Always re-measures droppables every frame so the tree
    // lists revealed by that same tab switch become valid drop targets mid-drag.
    contextProps: {
      sensors,
      collisionDetection: pointerWithin,
      measuring: { droppable: { strategy: MeasuringStrategy.Always } },
      onDragStart, onDragMove, onDragEnd, onDragCancel: endDrag,
    },
    overlay,
  };
}

/** Shallow DFS returning just the block (label lookup for the overlay). */
function findBlock(blocks: Block[], id: string): Block | null {
  for (const b of blocks) {
    if (b.id === id) return b;
    if (b.children) { const f = findBlock(b.children, id); if (f) return f; }
    if (b.slots) for (const s of b.slots) { const f = findBlock(s, id); if (f) return f; }
  }
  return null;
}

const dragOverlayPill: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 6, maxWidth: 240,
  padding: '.35rem .6rem', background: '#1f1f3d', color: '#e4e4e7',
  border: '1px solid #6366f1', borderRadius: 6, fontSize: '.85rem',
  boxShadow: '0 8px 24px rgba(0,0,0,0.45)', cursor: 'grabbing',
};
