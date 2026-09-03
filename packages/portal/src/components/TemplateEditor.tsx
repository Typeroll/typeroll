// Block-tree editor for PageTemplate docs.
//
// Reuses BlockLibrary / BlockTree / BlockFieldForm from BlockPageEditor.
// Differences from the page editor:
//   - target resource is a PageTemplate, not a Page (no slug, no SEO,
//     no preview iframe — templates render through whichever pages use
//     them)
//   - mutations happen client-side on the in-memory block tree, then
//     the full tree is PATCH'd back to /api/sites/{id}/templates?id=…
//     after each change. No granular mutation routes for templates
//     (yet — the tree is small enough that whole-tree PATCH is fine)
//   - the block library is extended with the reserved
//     `template_content_slot` block, since that's the whole point of
//     a template

import { useEffect, useMemo, useState } from 'react';
import type { Block, BlockType, PageTemplate } from '@typeroll/shared';
import { CORE_BLOCK_TYPES, TEMPLATE_CONTENT_SLOT_TYPE_ID } from '@typeroll/shared';
import { Plus, GripVertical, Save, ArrowLeft } from 'lucide-react';
import { DndContext, DragOverlay } from '@dnd-kit/core';
import { BlockLibrary, BlockTree, BlockFieldForm, DeviceToggle, DEFAULT_BP, ICONS } from './BlockPageEditor';
import { useBlockDnd } from './block-dnd';
import type { Breakpoint } from '@typeroll/shared';

interface Props {
  siteId: string;
  template: PageTemplate;
}

type LeftTab = 'add' | 'structure';
type Status = 'idle' | 'saving' | 'saved' | 'error';

// Client-side mirror of lib/block-mutations.ts — same signatures but
// returns the new tree directly so we can PATCH it back to the server.

function newBlockId(): string {
  return `blk_${Math.random().toString(36).slice(2, 14)}`;
}

function clone(blocks: Block[]): Block[] {
  return structuredClone(blocks);
}

function findIn(blocks: Block[], id: string): { block: Block; parent: Block | null; slot: number | null } | null {
  for (const b of blocks) {
    if (b.id === id) return { block: b, parent: null, slot: null };
    if (b.children) {
      for (const c of b.children) {
        if (c.id === id) return { block: c, parent: b, slot: null };
        const deep = findIn([c], id);
        if (deep) return deep;
      }
    }
    if (b.slots) {
      for (let i = 0; i < b.slots.length; i++) {
        for (const c of b.slots[i]) {
          if (c.id === id) return { block: c, parent: b, slot: i };
          const deep = findIn([c], id);
          if (deep) return deep;
        }
      }
    }
  }
  return null;
}

function removeBlock(blocks: Block[], id: string): Block[] {
  const tree = clone(blocks);
  function walk(list: Block[]): boolean {
    for (let i = 0; i < list.length; i++) {
      if (list[i].id === id) { list.splice(i, 1); return true; }
      if (list[i].children && walk(list[i].children!)) return true;
      if (list[i].slots) {
        for (const slot of list[i].slots!) if (walk(slot)) return true;
      }
    }
    return false;
  }
  walk(tree);
  return tree;
}

function addBlock(blocks: Block[], block: Block, parentId: string | null, slotIdx?: number, position?: number): { tree: Block[]; addedId: string } {
  const tree = clone(blocks);
  const ensured: Block = { ...block, id: block.id || newBlockId() };
  if (!parentId) {
    const pos = position ?? tree.length;
    tree.splice(Math.min(pos, tree.length), 0, ensured);
    return { tree, addedId: ensured.id };
  }
  const found = findIn(tree, parentId);
  if (!found) throw new Error(`Parent block not found: ${parentId}`);
  if (found.block.slots) {
    const idx = slotIdx ?? 0;
    while (found.block.slots.length <= idx) found.block.slots.push([]);
    const slot = found.block.slots[idx];
    slot.splice(position ?? slot.length, 0, ensured);
  } else {
    if (!found.block.children) found.block.children = [];
    found.block.children.splice(position ?? found.block.children.length, 0, ensured);
  }
  return { tree, addedId: ensured.id };
}

function updateBlockData(blocks: Block[], id: string, data: Record<string, unknown>): Block[] {
  const tree = clone(blocks);
  const found = findIn(tree, id);
  if (!found) return tree;
  found.block.data = { ...found.block.data, ...data };
  return tree;
}

function setBlockName(blocks: Block[], id: string, name: string): Block[] {
  const tree = clone(blocks);
  const found = findIn(tree, id);
  if (!found) return tree;
  const n = name.trim();
  if (n) found.block.name = n;
  else delete found.block.name;
  return tree;
}

/** True when `descendantId` lives anywhere inside `block`'s subtree — used to
 *  refuse moving a container into its own descendant (would cycle). */
function subtreeContains(block: Block, descendantId: string): boolean {
  if (block.id === descendantId) return true;
  if (block.children?.some((c) => subtreeContains(c, descendantId))) return true;
  if (block.slots?.some((s) => s.some((c) => subtreeContains(c, descendantId)))) return true;
  return false;
}

/** Relocate a block to a container + position: remove it, then re-insert. */
function moveBlockTo(
  blocks: Block[], id: string,
  parentId: string | null, slotIdx: number | undefined, position: number,
): Block[] {
  const found = findIn(blocks, id);
  if (!found) return blocks;
  if (parentId && subtreeContains(found.block, parentId)) return blocks; // cycle guard
  const moved = structuredClone(found.block);
  const without = removeBlock(blocks, id);
  return addBlock(without, moved, parentId, slotIdx, position).tree;
}

export default function TemplateEditor({ siteId, template }: Props) {
  const [draft, setDraft] = useState<PageTemplate>(template);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string | null>(null);
  const [activeBp, setActiveBp] = useState<Breakpoint>(DEFAULT_BP);
  const [leftTab, setLeftTab] = useState<LeftTab>(
    (template.blocks?.length ?? 0) > 0 ? 'structure' : 'add',
  );

  // Block-type registry: core + custom + the reserved
  // template_content_slot (so it shows up in the library — it normally
  // wouldn't, since BlockLibrary hides it explicitly. We re-include it
  // via a "Template-only" category prepend below).
  const [customTypes, setCustomTypes] = useState<BlockType[]>([]);
  useEffect(() => {
    fetch(`/api/sites/${siteId}/blocks/list`)
      .then((r) => r.ok ? r.json() as Promise<{ block_types: BlockType[] }> : Promise.resolve({ block_types: [] }))
      .then((j) => setCustomTypes(j.block_types ?? []))
      .catch(() => {});
  }, [siteId]);

  const registry = useMemo(() => {
    const m = new Map<string, BlockType>();
    for (const bt of CORE_BLOCK_TYPES) m.set(bt.id, bt);
    for (const bt of customTypes) m.set(bt.id, bt);
    return m;
  }, [customTypes]);

  const selected = useMemo(() => {
    if (!selectedId) return null;
    return findIn(draft.blocks ?? [], selectedId);
  }, [draft.blocks, selectedId]);

  async function persist(nextBlocks: Block[]): Promise<void> {
    setStatus('saving');
    setError(null);
    try {
      const res = await fetch(`/api/sites/${siteId}/templates?id=${encodeURIComponent(template.id)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ blocks: nextBlocks }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(j.error ?? `Save failed (${res.status})`);
      }
      const body = await res.json() as PageTemplate;
      setDraft(body);
      setStatus('saved');
      window.setTimeout(() => setStatus('idle'), 1200);
    } catch (e) {
      setError((e as Error).message);
      setStatus('error');
    }
  }

  function handleAdd(typeId: string): void {
    const bt = registry.get(typeId);
    const data: Record<string, unknown> = {};
    if (bt) for (const f of bt.schema) if (f.default !== undefined) data[f.name] = f.default;
    const block: Block = { id: '', type: typeId, data };
    const parentId = selected && (selected.block.children !== undefined || selected.block.slots !== undefined)
      ? selected.block.id : null;
    const { tree, addedId } = addBlock(draft.blocks ?? [], block, parentId, 0);
    setDraft({ ...draft, blocks: tree });
    setSelectedId(addedId);
    void persist(tree);
  }

  function handleAddSlot(): void {
    handleAdd(TEMPLATE_CONTENT_SLOT_TYPE_ID);
  }

  function handleRemove(id: string): void {
    if (!confirm('Delete this block?')) return;
    const tree = removeBlock(draft.blocks ?? [], id);
    setDraft({ ...draft, blocks: tree });
    if (selectedId === id) setSelectedId(null);
    void persist(tree);
  }

  function handleDuplicate(id: string): void {
    const tree = clone(draft.blocks ?? []);
    const found = findIn(tree, id);
    if (!found) return;
    const reassign = (b: Block): Block => ({
      ...b,
      id: newBlockId(),
      children: b.children?.map(reassign),
      slots: b.slots?.map((slot) => slot.map(reassign)),
    });
    const copy = reassign(structuredClone(found.block));
    const list = found.parent
      ? (found.slot != null ? found.parent.slots![found.slot] : found.parent.children!)
      : tree;
    list.splice(list.findIndex((b) => b.id === id) + 1, 0, copy);
    setDraft({ ...draft, blocks: tree });
    setSelectedId(copy.id);
    void persist(tree);
  }

  function handleUpdateData(id: string, data: Record<string, unknown>): void {
    const tree = updateBlockData(draft.blocks ?? [], id, data);
    setDraft({ ...draft, blocks: tree });
    void persist(tree);
  }

  function handleRename(id: string, name: string): void {
    const tree = setBlockName(draft.blocks ?? [], id, name);
    setDraft({ ...draft, blocks: tree });
    void persist(tree);
  }

  // Positional insert used by drag-from-library (click-to-add stays as
  // handleAdd, which drops into the selected container).
  function handleAddAt(typeId: string, parentId: string | null, slotIdx: number | undefined, position: number): void {
    const bt = registry.get(typeId);
    const data: Record<string, unknown> = {};
    if (bt) for (const f of bt.schema) if (f.default !== undefined) data[f.name] = f.default;
    const { tree, addedId } = addBlock(draft.blocks ?? [], { id: '', type: typeId, data }, parentId, slotIdx, position);
    setDraft({ ...draft, blocks: tree });
    setSelectedId(addedId);
    void persist(tree);
  }

  function handleMove(id: string, parentId: string | null, slotIdx: number | undefined, targetPosition: number | undefined): void {
    const tree = moveBlockTo(draft.blocks ?? [], id, parentId, slotIdx, targetPosition ?? 0);
    setDraft({ ...draft, blocks: tree });
    void persist(tree);
  }

  const dnd = useBlockDnd({
    blocks: draft.blocks ?? [],
    registry,
    icons: ICONS,
    onAdd: handleAddAt,
    onMove: handleMove,
    onNewDragStart: () => setLeftTab('structure'),
  });

  async function setStatus_(s: 'draft' | 'published'): Promise<void> {
    const res = await fetch(`/api/sites/${siteId}/templates?id=${encodeURIComponent(template.id)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: s }),
    });
    if (res.ok) {
      const body = await res.json() as PageTemplate;
      setDraft(body);
    }
  }

  const hasContentSlot = useMemo(() => {
    function walk(list: Block[]): boolean {
      for (const b of list) {
        if (b.type === TEMPLATE_CONTENT_SLOT_TYPE_ID) return true;
        if (b.children && walk(b.children)) return true;
        if (b.slots) for (const s of b.slots) if (walk(s)) return true;
      }
      return false;
    }
    return walk(draft.blocks ?? []);
  }, [draft.blocks]);

  return (
    <div style={shell}>
      <header style={topBar}>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          <a href={`/app/sites/${siteId}/templates`} style={backLink}>
            <ArrowLeft size={14} /> Templates
          </a>
          <strong style={{ fontSize: '0.9rem' }}>{draft.label}</strong>
          <span style={{ fontSize: '0.75rem', opacity: 0.6 }}>{draft.name}</span>
          {status === 'saving' && <span style={muted}>Saving…</span>}
          {status === 'saved' && <span style={{ color: '#22c55e', fontSize: '.85rem' }}>Saved</span>}
          {status === 'error' && <span style={{ color: '#ef4444', fontSize: '.85rem' }}>{error}</span>}
        </div>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          {!hasContentSlot && (draft.blocks ?? []).length > 0 && (
            <span style={warnPill} title="This template has no template_content_slot — page content will render at the end">
              ⚠ Ingen content-slot
            </span>
          )}
          <select
            value={draft.status}
            onChange={(e) => void setStatus_(e.target.value as 'draft' | 'published')}
            style={statusSelect}
          >
            <option value="draft">Utkast</option>
            <option value="published">Published</option>
          </select>
          <DeviceToggle activeBp={activeBp} onChange={setActiveBp} />
        </div>
      </header>

      <DndContext {...dnd.contextProps}>
      <div style={threeCol}>
        <aside style={leftPanel}>
          <div style={tabBar}>
            <button type="button" style={tabBtn(leftTab === 'add')} onClick={() => setLeftTab('add')}>
              <Plus size={14} /> Add
            </button>
            <button type="button" style={tabBtn(leftTab === 'structure')} onClick={() => setLeftTab('structure')}>
              <GripVertical size={14} /> Structure
            </button>
          </div>
          <div style={leftBody}>
            {leftTab === 'add' && (
              <>
                <div style={slotShelf}>
                  <button type="button" onClick={handleAddSlot} style={slotButton}>
                    <Plus size={14} />
                    <div style={{ textAlign: 'left' }}>
                      <strong style={{ fontSize: '.85rem' }}>Content slot</strong>
                      <div style={{ fontSize: '.7rem', opacity: 0.7 }}>
                        Markerar var sidans egna block renderas
                      </div>
                    </div>
                  </button>
                </div>
                <BlockLibrary
                  registry={registry}
                  customTypes={customTypes}
                  onAdd={handleAdd}
                />
              </>
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

        <main style={centerPanel}>
          <div style={previewCard}>
            <h3 style={{ marginTop: 0, fontSize: '1rem' }}>Template preview</h3>
            <p style={muted}>
              Templates don't render on their own — they wrap a page. Open a page that uses
              this template and look at its preview to see the result.
            </p>
            <p style={muted}>
              The Structure tree shows the block hierarchy. Blocks of type
              <code style={{ background: '#1f1f23', padding: '0 .3rem', borderRadius: 3 }}>template_content_slot</code>
              are replaced by the page's own blocks at render time.
            </p>
          </div>
        </main>

        <aside style={rightPanel}>
          {selected ? (
            selected.block.type === TEMPLATE_CONTENT_SLOT_TYPE_ID ? (
              <div>
                <h3 style={{ marginTop: 0, fontSize: '.95rem' }}>Content slot</h3>
                <p style={muted}>
                  Detta block markerar var den konsumerande sidans egna block
                  renders. It has no fields of its own.
                </p>
              </div>
            ) : (
              <BlockFieldForm
                siteId={siteId}
                block={selected.block}
                blockType={registry.get(selected.block.type) ?? null}
                activeBp={activeBp}
                onChange={(data) => handleUpdateData(selected.block.id, data)}
              />
            )
          ) : (
            <div style={emptyHint}>
              <p style={{ marginTop: 0 }}>Inget block markerat.</p>
              <p style={{ fontSize: '.85rem', opacity: 0.7 }}>
                Add a content slot first, then build blocks around it.
              </p>
            </div>
          )}
        </aside>
      </div>
        <DragOverlay dropAnimation={null}>{dnd.overlay}</DragOverlay>
      </DndContext>
    </div>
  );
}

// ─── Styles (copied from BlockPageEditor to keep visual parity) ─────────

const shell: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', height: '100vh',
  background: '#0f0f12', color: '#e4e4e7',
};
const topBar: React.CSSProperties = {
  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
  padding: '0.5rem 1rem', borderBottom: '1px solid #2a2a30', gap: '1rem',
};
const backLink: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 4,
  color: '#a1a1aa', textDecoration: 'none', fontSize: '.8rem',
};
const threeCol: React.CSSProperties = {
  display: 'grid', gridTemplateColumns: '280px 1fr 320px', flex: 1, overflow: 'hidden',
};
const leftPanel: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', borderRight: '1px solid #2a2a30', overflow: 'hidden',
};
const tabBar: React.CSSProperties = {
  display: 'grid', gridTemplateColumns: '1fr 1fr', borderBottom: '1px solid #2a2a30',
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
const centerPanel: React.CSSProperties = { padding: '1rem', overflow: 'auto', background: '#0a0a0d' };
const rightPanel: React.CSSProperties = {
  borderLeft: '1px solid #2a2a30', padding: '1rem', overflow: 'auto',
};
const previewCard: React.CSSProperties = {
  background: '#161618', border: '1px solid #2a2a30', borderRadius: 8,
  padding: '1.5rem',
};
const emptyHint: React.CSSProperties = { padding: '1rem', color: '#a1a1aa' };
const slotShelf: React.CSSProperties = { marginBottom: '0.75rem' };
const slotButton: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 10, padding: '.6rem .75rem',
  width: '100%', background: '#1a1a3d', color: '#fafafa',
  border: '1px solid #4338ca', borderRadius: 6, cursor: 'pointer',
};
const muted: React.CSSProperties = { color: '#a1a1aa', fontSize: '.85rem', margin: '0 0 .5rem' };
const warnPill: React.CSSProperties = {
  fontSize: '.7rem', padding: '.2rem .5rem', background: '#3b2410', color: '#fbbf24',
  borderRadius: 999, border: '1px solid #92400e',
};
const statusSelect: React.CSSProperties = {
  padding: '.3rem .5rem', background: '#1f1f23', color: '#fafafa',
  border: '1px solid #2a2a30', borderRadius: 6, fontSize: '.8rem',
};
