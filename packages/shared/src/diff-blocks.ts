// Structural diff over two Block[] trees — the engine behind "review
// changes" (draft vs saved, branch vs main). Pure and shared so the portal
// UI, the v1 REST change-summary route, and agents (get_change_summary via
// MCP) all describe an edit the same way.
//
// Blocks are matched by id (ids are stable across edits — mutations only
// re-mint ids on duplicate/paste), so the diff is O(n) and never guesses.

import type { Block } from './types.js';

export interface BlockChange {
  kind: 'added' | 'removed' | 'changed' | 'moved';
  block_id: string;
  /** Block type of the after-side block (before-side for removals). */
  type: string;
  /** User-given block name, when set — helps humans locate it. */
  name?: string;
  /** For `changed`: which data fields differ (plus "name" for renames). */
  fields?: string[];
  /** For `moved`: container paths ("root[2]", "sec1.children[0]", "cols.slot0[1]"). */
  from?: string;
  to?: string;
}

interface IndexEntry {
  block: Block;
  /** Human-readable container position. */
  path: string;
  /** Parent id ('' = root) + slot + index — the identity of "where". */
  parentKey: string;
}

function indexTree(blocks: Block[]): Map<string, IndexEntry> {
  const out = new Map<string, IndexEntry>();
  const walk = (list: Block[], parentId: string, slot: number | null, parentLabel: string) => {
    list.forEach((b, i) => {
      const path = `${parentLabel}[${i}]`;
      out.set(b.id, {
        block: b,
        path,
        parentKey: `${parentId}${slot != null ? `:slot${slot}` : ''}:${i}`,
      });
      if (b.children) walk(b.children, b.id, null, `${b.id}.children`);
      if (b.slots) b.slots.forEach((s, si) => walk(s, b.id, si, `${b.id}.slot${si}`));
    });
  };
  walk(blocks, '', null, 'root');
  return out;
}

/** Shallow keys whose JSON differs between two data objects. */
function changedDataFields(a: Record<string, unknown>, b: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const out: string[] = [];
  for (const k of keys) {
    if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) out.push(k);
  }
  return out.sort();
}

/** ids in `only` whose block is NOT inside another `only` block's subtree —
 *  a pasted/removed section reports once, not once per descendant. */
function subtreeRoots(only: string[], index: Map<string, IndexEntry>): string[] {
  return only.filter(
    (id) => !only.some((other) => other !== id && subtreeContains(index.get(other)!.block, id)),
  );
}

export function diffBlocks(before: Block[], after: Block[]): BlockChange[] {
  const a = indexTree(before);
  const b = indexTree(after);
  const changes: BlockChange[] = [];

  const addedIds = [...b.keys()].filter((id) => !a.has(id));
  for (const id of subtreeRoots(addedIds, b)) {
    const entry = b.get(id)!;
    changes.push({ kind: 'added', block_id: id, type: entry.block.type, name: entry.block.name });
  }

  for (const [id, entry] of b) {
    const prev = a.get(id);
    if (!prev) continue; // added — handled above
    const fields = changedDataFields(
      (prev.block.data ?? {}) as Record<string, unknown>,
      (entry.block.data ?? {}) as Record<string, unknown>,
    );
    if ((prev.block.name ?? '') !== (entry.block.name ?? '')) fields.push('name');
    if (fields.length > 0) {
      changes.push({ kind: 'changed', block_id: id, type: entry.block.type, name: entry.block.name, fields });
    }
    if (prev.parentKey !== entry.parentKey) {
      changes.push({
        kind: 'moved', block_id: id, type: entry.block.type, name: entry.block.name,
        from: prev.path, to: entry.path,
      });
    }
  }

  const removedIds = [...a.keys()].filter((id) => !b.has(id));
  for (const id of subtreeRoots(removedIds, a)) {
    const entry = a.get(id)!;
    changes.push({ kind: 'removed', block_id: id, type: entry.block.type, name: entry.block.name });
  }

  return changes;
}

function subtreeContains(root: Block, id: string): boolean {
  for (const c of root.children ?? []) {
    if (c.id === id || subtreeContains(c, id)) return true;
  }
  for (const slot of root.slots ?? []) {
    for (const c of slot) {
      if (c.id === id || subtreeContains(c, id)) return true;
    }
  }
  return false;
}
