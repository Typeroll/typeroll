// Block-tree mutations for the page editor + MCP tools.
//
// These operate purely on `Block[]` arrays. The caller is responsible for
// fetching the page, applying a mutation, and writing it back through the
// vstore (which handles revisions + COW). Keeping the mutations pure-
// function lets the MCP server, chat tools, and the React editor share
// the exact same semantics — no drift between client-side optimistic
// updates and what the server ultimately persists.

import { randomUUID } from 'node:crypto';
import { buildCoreBlockRegistry, ensureBlockIds, type Block, type BlockType } from '@typeroll/shared';

let coreRegistry: Map<string, BlockType> | null = null;

/**
 * Slot arity for core slot-container types (core/columns, core/tabs).
 * Custom per-site slot containers aren't visible here (the mutations are
 * pure functions with no datastore access) — for those, an explicit
 * `slot_index` or an instance that already carries `slots` opts into the
 * slots path instead.
 */
function coreSlotArity(type: string | undefined): number | null {
  if (!type) return null;
  coreRegistry ??= buildCoreBlockRegistry();
  const bt = coreRegistry.get(type);
  if (!bt || bt.container !== 'slots') return null;
  return bt.slot_count ?? bt.slot_labels?.length ?? 1;
}

export interface FindResult {
  block: Block;
  parent: Block | null;
  parentSlotIndex: number | null;
  index: number;
}

/**
 * DFS for a block by id. Returns the block plus its parent + position so
 * mutations can rewire neighbors without re-walking. parent === null
 * means the block is at the top level.
 */
export function findBlock(blocks: Block[], blockId: string): FindResult | null {
  return findIn(blocks, blockId, null, null);
}

function findIn(
  list: Block[],
  blockId: string,
  parent: Block | null,
  parentSlotIndex: number | null,
): FindResult | null {
  for (let i = 0; i < list.length; i++) {
    const b = list[i];
    if (b.id === blockId) return { block: b, parent, parentSlotIndex, index: i };
    if (b.children?.length) {
      const found = findIn(b.children, blockId, b, null);
      if (found) return found;
    }
    if (b.slots?.length) {
      for (let s = 0; s < b.slots.length; s++) {
        const found = findIn(b.slots[s], blockId, b, s);
        if (found) return found;
      }
    }
  }
  return null;
}

/** Allocate a stable id for a fresh block. */
export function newBlockId(): string {
  return `blk_${randomUUID().slice(0, 12)}`;
}

/**
 * Add a new block. When parent_id is null, insert at top level. When
 * parent_id refers to a slot-container block, slot_index picks the slot
 * (default 0). Position defaults to "end".
 *
 * Mutates a deep copy of the tree — the original is left intact so the
 * caller can keep the pre-mutation value for diffing.
 */
export function addBlock(
  blocks: Block[],
  args: {
    block: Block;
    parent_id?: string | null;
    slot_index?: number;
    position?: number;
  },
): { blocks: Block[]; added_id: string } {
  const tree = cloneTree(blocks);
  const block = ensureId({ ...args.block });

  // A freshly inserted slot container (e.g. a bare `{type: 'core/columns'}`)
  // gets its slots initialised to the type's arity, so the renderer and a
  // follow-up add_block with parent_id + slot_index both see the slot
  // structure instead of silently falling back to `children`.
  const ownArity = coreSlotArity(block.type);
  if (ownArity != null && !block.slots) {
    block.slots = Array.from({ length: ownArity }, () => []);
  }

  if (!args.parent_id) {
    const pos = clampPos(args.position, tree.length);
    tree.splice(pos, 0, block);
    // The inserted payload may be a whole subtree (nested children/slots)
    // authored without ids — normalise the full tree so every persisted
    // block stays addressable and the renderer never sees an id-less block.
    ensureBlockIds(tree);
    return { blocks: tree, added_id: block.id };
  }

  const found = findBlock(tree, args.parent_id);
  if (!found) throw new BlockMutationError(`Parent block not found: ${args.parent_id}`, 'not_found');

  // Slot path when any of: the instance already has slots, the caller asked
  // for a slot explicitly, or the parent's type is a known slot container
  // (covers instances persisted before slots-initialisation existed).
  const parentArity = coreSlotArity(found.block.type);
  if (found.block.slots || args.slot_index != null || parentArity != null) {
    if (!found.block.slots) {
      found.block.slots = Array.from({ length: parentArity ?? 0 }, () => []);
    }
    const slotIdx = args.slot_index ?? 0;
    while (found.block.slots.length <= slotIdx) found.block.slots.push([]);
    const slot = found.block.slots[slotIdx];
    slot.splice(clampPos(args.position, slot.length), 0, block);
  } else {
    if (!found.block.children) found.block.children = [];
    found.block.children.splice(clampPos(args.position, found.block.children.length), 0, block);
  }
  ensureBlockIds(tree);
  return { blocks: tree, added_id: block.id };
}

/**
 * Update a block in place — merges new `data` shallow-merge, optionally
 * replaces `style_overrides`. Does not touch children/slots.
 */
export function updateBlock(
  blocks: Block[],
  args: {
    block_id: string;
    data?: Record<string, unknown>;
    style_overrides?: Block['style_overrides'];
    responsive?: Block['responsive'];
    /** Editorial tree label. Empty/whitespace clears it back to the derived label. */
    name?: string;
  },
): Block[] {
  const tree = cloneTree(blocks);
  const found = findBlock(tree, args.block_id);
  if (!found) throw new BlockMutationError(`Block not found: ${args.block_id}`, 'not_found');
  if (args.data) found.block.data = { ...found.block.data, ...args.data };
  if (args.style_overrides !== undefined) found.block.style_overrides = args.style_overrides;
  if (args.responsive !== undefined) found.block.responsive = args.responsive;
  if (args.name !== undefined) {
    const n = args.name.trim();
    if (n) found.block.name = n;
    else delete found.block.name;
  }
  return tree;
}

/**
 * Move a block to a new parent + position. The block is removed from its
 * current location and inserted at the target. target_parent_id=null
 * means "move to top level".
 */
export function moveBlock(
  blocks: Block[],
  args: {
    block_id: string;
    target_parent_id?: string | null;
    target_slot_index?: number;
    target_position?: number;
  },
): Block[] {
  const tree = cloneTree(blocks);
  const removed = removeFromTree(tree, args.block_id);
  if (!removed) throw new BlockMutationError(`Block not found: ${args.block_id}`, 'not_found');

  // Prevent moving a container into its own descendant — that would
  // create a cycle.
  if (args.target_parent_id) {
    if (containsDescendant(removed.block, args.target_parent_id)) {
      throw new BlockMutationError(
        `Cannot move block into its own descendant: ${args.target_parent_id}`,
        'cycle',
      );
    }
  }

  return addBlock(tree, {
    block: removed.block,
    parent_id: args.target_parent_id ?? null,
    slot_index: args.target_slot_index,
    position: args.target_position,
  }).blocks;
}

/** Remove a block (and everything inside it) from the tree. */
export function removeBlock(blocks: Block[], blockId: string): Block[] {
  const tree = cloneTree(blocks);
  const removed = removeFromTree(tree, blockId);
  if (!removed) throw new BlockMutationError(`Block not found: ${blockId}`, 'not_found');
  return tree;
}

/**
 * Clone a block (subtree included), assign fresh ids, and insert the clone
 * directly after the original in whichever list it lives in. Returns the
 * new tree + the duplicate's new id so the caller can chase it for
 * follow-up edits.
 */
export function duplicateBlock(
  blocks: Block[],
  blockId: string,
): { tree: Block[]; duplicate_id: string } {
  const tree = cloneTree(blocks);
  const found = findBlock(tree, blockId);
  if (!found) throw new BlockMutationError(`Block not found: ${blockId}`, 'not_found');
  const copy = reassignIds(structuredClone(found.block));
  // Find the actual list that holds the original — top-level, parent's
  // children, or parent's slot[i] — and insert the clone right after.
  let list: Block[];
  if (found.parent == null) {
    list = tree;
  } else if (found.parentSlotIndex != null) {
    list = found.parent.slots![found.parentSlotIndex]!;
  } else {
    list = found.parent.children!;
  }
  list.splice(found.index + 1, 0, copy);
  return { tree, duplicate_id: copy.id };
}

/**
 * Set a per-breakpoint value on a single field of a block. Pass either:
 *   - a scalar (collapses any prior responsive object back to a flat value)
 *   - a partial object { mobile?, tablet?, laptop?, desktop?, wide? }
 *     which gets shallow-merged into the existing value if the existing
 *     value is already a responsive object; otherwise replaces it
 *     wholesale (with the previous scalar as the mobile baseline if
 *     none was provided).
 */
export function setBlockResponsiveField(
  blocks: Block[],
  args: { block_id: string; field: string; value: unknown },
): Block[] {
  const tree = cloneTree(blocks);
  const found = findBlock(tree, args.block_id);
  if (!found) throw new BlockMutationError(`Block not found: ${args.block_id}`, 'not_found');
  const data = found.block.data ?? (found.block.data = {});
  const prev = data[args.field];
  const isPartialBpObject = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v) &&
    ['mobile', 'tablet', 'laptop', 'desktop', 'wide'].some((k) => k in (v as object));

  // Coerce a JSON-encoded breakpoint object back into an object. The tool's
  // `value` is `z.any()`, so a client (or LLM) that passes the per-breakpoint
  // map as a STRING — `"{\"mobile\":1,\"tablet\":2}"` — would otherwise hit the
  // scalar branch below and be stored verbatim as a string, silently breaking
  // the field (the renderer expects an object) and clobbering any prior value.
  // Only JSON that parses to a breakpoint object is unwrapped; a genuine scalar
  // string (e.g. an align token like "start") never looks like `{…}` and is
  // left untouched.
  let value = args.value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('{')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (isPartialBpObject(parsed)) value = parsed;
      } catch {
        // Not valid JSON — treat as an ordinary scalar string below.
      }
    }
  }

  if (isPartialBpObject(value)) {
    if (isPartialBpObject(prev)) {
      data[args.field] = { ...prev, ...value };
    } else {
      const baseline = prev != null && typeof prev !== 'object'
        ? { mobile: prev }
        : {};
      data[args.field] = { ...baseline, ...value };
    }
  } else {
    // Scalar collapses any prior responsive object.
    data[args.field] = value;
  }
  return tree;
}

function reassignIds(block: Block): Block {
  block.id = newBlockId();
  if (block.children?.length) block.children = block.children.map((c) => reassignIds(c));
  if (block.slots?.length) block.slots = block.slots.map((slot) => slot.map((c) => reassignIds(c)));
  return block;
}

// ─── Errors ──────────────────────────────────────────────────────────────

export class BlockMutationError extends Error {
  constructor(
    message: string,
    public readonly code: 'not_found' | 'cycle' | 'invalid',
  ) {
    super(message);
    this.name = 'BlockMutationError';
  }
}

// ─── Internal helpers ────────────────────────────────────────────────────

function cloneTree(blocks: Block[]): Block[] {
  // structuredClone handles Block (no functions, no DOM refs).
  return structuredClone(blocks);
}

function clampPos(p: number | undefined, max: number): number {
  if (p === undefined || p < 0) return max;
  if (p > max) return max;
  return Math.floor(p);
}

function ensureId(b: Block): Block {
  if (!b.id) b.id = newBlockId();
  return b;
}

function removeFromTree(
  blocks: Block[],
  blockId: string,
): { block: Block } | null {
  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i].id === blockId) {
      const [block] = blocks.splice(i, 1);
      return { block };
    }
    if (blocks[i].children?.length) {
      const r = removeFromTree(blocks[i].children!, blockId);
      if (r) return r;
    }
    if (blocks[i].slots?.length) {
      for (const slot of blocks[i].slots!) {
        const r = removeFromTree(slot, blockId);
        if (r) return r;
      }
    }
  }
  return null;
}

function containsDescendant(block: Block, descendantId: string): boolean {
  if (block.id === descendantId) return true;
  if (block.children) {
    for (const c of block.children) {
      if (containsDescendant(c, descendantId)) return true;
    }
  }
  if (block.slots) {
    for (const slot of block.slots) {
      for (const c of slot) {
        if (containsDescendant(c, descendantId)) return true;
      }
    }
  }
  return false;
}
