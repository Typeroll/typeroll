// Client-side block tree edits that return a new tree. Editors that keep the
// whole tree in memory and write it back in one request (page templates,
// global blocks, a block type's composition) share these; the page editor
// uses the server-side mutation routes in lib/block-mutations.ts instead.
// Browser-safe: no server imports.

import type { Block } from '@typeroll/shared';

export function newBlockId(): string {
  return `blk_${Math.random().toString(36).slice(2, 14)}`;
}

export function cloneTree(blocks: Block[]): Block[] {
  return structuredClone(blocks);
}

export interface FoundBlock {
  block: Block;
  parent: Block | null;
  slot: number | null;
}

export function findBlockIn(blocks: Block[], id: string): FoundBlock | null {
  for (const b of blocks) {
    if (b.id === id) return { block: b, parent: null, slot: null };
    if (b.children) {
      for (const c of b.children) {
        if (c.id === id) return { block: c, parent: b, slot: null };
        const deep = findBlockIn([c], id);
        if (deep) return deep;
      }
    }
    if (b.slots) {
      for (let i = 0; i < b.slots.length; i++) {
        for (const c of b.slots[i]!) {
          if (c.id === id) return { block: c, parent: b, slot: i };
          const deep = findBlockIn([c], id);
          if (deep) return deep;
        }
      }
    }
  }
  return null;
}

/** The list that holds the block `id` (the root list, a children list or a slot). */
function siblingsOf(tree: Block[], found: FoundBlock): Block[] {
  if (!found.parent) return tree;
  return found.slot != null ? found.parent.slots![found.slot]! : found.parent.children!;
}

export function removeBlockFrom(blocks: Block[], id: string): Block[] {
  const tree = cloneTree(blocks);
  const found = findBlockIn(tree, id);
  if (!found) return tree;
  const list = siblingsOf(tree, found);
  list.splice(list.findIndex(b => b.id === id), 1);
  return tree;
}

export function addBlockTo(blocks: Block[], block: Block, parentId: string | null, slotIdx?: number, position?: number): { tree: Block[]; addedId: string } {
  const tree = cloneTree(blocks);
  const ensured: Block = { ...block, id: block.id || newBlockId() };
  if (!parentId) {
    const pos = position ?? tree.length;
    tree.splice(Math.min(pos, tree.length), 0, ensured);
    return { tree, addedId: ensured.id };
  }
  const found = findBlockIn(tree, parentId);
  if (!found) throw new Error(`Parent block not found: ${parentId}`);
  if (found.block.slots) {
    const idx = slotIdx ?? 0;
    while (found.block.slots.length <= idx) found.block.slots.push([]);
    const slot = found.block.slots[idx]!;
    slot.splice(position ?? slot.length, 0, ensured);
  } else {
    if (!found.block.children) found.block.children = [];
    found.block.children.splice(position ?? found.block.children.length, 0, ensured);
  }
  return { tree, addedId: ensured.id };
}

export function updateBlockDataIn(blocks: Block[], id: string, data: Record<string, unknown>): Block[] {
  const tree = cloneTree(blocks);
  const found = findBlockIn(tree, id);
  if (!found) return tree;
  found.block.data = { ...found.block.data, ...data };
  return tree;
}

export function setStyleOverridesIn(blocks: Block[], id: string, overrides: Block['style_overrides']): Block[] {
  const tree = cloneTree(blocks);
  const found = findBlockIn(tree, id);
  if (!found) return tree;
  if (overrides && Object.keys(overrides).length) found.block.style_overrides = overrides;
  else delete found.block.style_overrides;
  return tree;
}

export function setBlockNameIn(blocks: Block[], id: string, name: string): Block[] {
  const tree = cloneTree(blocks);
  const found = findBlockIn(tree, id);
  if (!found) return tree;
  const n = name.trim();
  if (n) found.block.name = n;
  else delete found.block.name;
  return tree;
}

/** True when `descendantId` lives anywhere inside `block`'s subtree. */
export function subtreeContains(block: Block, descendantId: string): boolean {
  if (block.id === descendantId) return true;
  if (block.children?.some((c) => subtreeContains(c, descendantId))) return true;
  if (block.slots?.some((s) => s.some((c) => subtreeContains(c, descendantId)))) return true;
  return false;
}

/** Relocate a block to a container + position: remove it, then re-insert. */
export function moveBlockIn(
  blocks: Block[], id: string,
  parentId: string | null, slotIdx: number | undefined, position: number,
): Block[] {
  const found = findBlockIn(blocks, id);
  if (!found) return blocks;
  if (parentId && subtreeContains(found.block, parentId)) return blocks; // cycle guard
  const moved = structuredClone(found.block);
  const without = removeBlockFrom(blocks, id);
  return addBlockTo(without, moved, parentId, slotIdx, position).tree;
}

/** A deep copy of `block` where it and every descendant get a fresh id. */
export function withFreshIds(block: Block, makeId: () => string = newBlockId): Block {
  const reassign = (b: Block): Block => ({
    ...b,
    id: makeId(),
    ...(b.children ? { children: b.children.map(reassign) } : {}),
    ...(b.slots ? { slots: b.slots.map((slot) => slot.map(reassign)) } : {}),
  });
  return reassign(structuredClone(block));
}

/** Insert a copy of block `id` (fresh ids) right after it. */
export function duplicateBlockIn(blocks: Block[], id: string): { tree: Block[]; copyId: string | null } {
  const tree = cloneTree(blocks);
  const found = findBlockIn(tree, id);
  if (!found) return { tree, copyId: null };
  const copy = withFreshIds(found.block);
  const list = siblingsOf(tree, found);
  list.splice(list.findIndex((b) => b.id === id) + 1, 0, copy);
  return { tree, copyId: copy.id };
}

/** Replace block `id` with `replacement` (zero or more blocks) at the same position. */
export function replaceBlockIn(blocks: Block[], id: string, replacement: Block[]): Block[] {
  const tree = cloneTree(blocks);
  const found = findBlockIn(tree, id);
  if (!found) return tree;
  const list = siblingsOf(tree, found);
  list.splice(list.findIndex((b) => b.id === id), 1, ...structuredClone(replacement));
  return tree;
}

/** Every block id in a tree. */
export function collectBlockIds(blocks: readonly Block[], out: Set<string> = new Set()): Set<string> {
  for (const b of blocks) {
    out.add(b.id);
    if (b.children) collectBlockIds(b.children, out);
    for (const slot of b.slots ?? []) collectBlockIds(slot, out);
  }
  return out;
}
