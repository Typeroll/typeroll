// Pure-function coverage for the shared block-editor DnD logic: containerId
// parsing, container resolution, and the drop-gap → add/move translation that
// the colored drop-line + drop dispatch depend on.

import { describe, it, expect } from 'vitest';
import type { Block } from '@typeroll/shared';
import {
  isContainerId, parseContainerId, listOf, locateBlock, resolveDrop,
  type ActiveDrag, type DropTarget,
} from '../../components/block-dnd';

const b = (id: string, extra: Partial<Block> = {}): Block => ({ id, type: 'core/prose', data: {}, ...extra });

// A tree: root has [a, b, container c(children: [c1, c2]), cols(slots: [[s0], [s1a, s1b]])].
const tree: Block[] = [
  b('a'),
  b('b'),
  b('c', { type: 'core/section', children: [b('c1'), b('c2')] }),
  b('cols', { type: 'core/columns', slots: [[b('s0')], [b('s1a'), b('s1b')]] }),
];

describe('containerId helpers', () => {
  it('recognises container ids', () => {
    expect(isContainerId('root')).toBe(true);
    expect(isContainerId('block:c:children')).toBe(true);
    expect(isContainerId('block:cols:slot:1')).toBe(true);
    expect(isContainerId('a')).toBe(false);
  });

  it('parses container ids to parent + slot', () => {
    expect(parseContainerId('root')).toEqual({ parentId: null });
    expect(parseContainerId('block:c:children')).toEqual({ parentId: 'c' });
    expect(parseContainerId('block:cols:slot:1')).toEqual({ parentId: 'cols', slotIdx: 1 });
  });

  it('resolves a containerId to the right block list', () => {
    expect(listOf(tree, 'root').map((x) => x.id)).toEqual(['a', 'b', 'c', 'cols']);
    expect(listOf(tree, 'block:c:children').map((x) => x.id)).toEqual(['c1', 'c2']);
    expect(listOf(tree, 'block:cols:slot:0').map((x) => x.id)).toEqual(['s0']);
    expect(listOf(tree, 'block:cols:slot:1').map((x) => x.id)).toEqual(['s1a', 's1b']);
  });
});

describe('locateBlock — canvas hit-test inverse of listOf', () => {
  it('locates a top-level block', () => {
    expect(locateBlock(tree, 'b')).toEqual({ containerId: 'root', index: 1 });
  });
  it('locates a nested child block', () => {
    expect(locateBlock(tree, 'c2')).toEqual({ containerId: 'block:c:children', index: 1 });
  });
  it('locates a block inside a slot', () => {
    expect(locateBlock(tree, 's1b')).toEqual({ containerId: 'block:cols:slot:1', index: 1 });
  });
  it('returns null for an unknown id', () => {
    expect(locateBlock(tree, 'nope')).toBeNull();
  });
  it('round-trips with listOf (the block sits at its located index)', () => {
    const loc = locateBlock(tree, 's0')!;
    expect(listOf(tree, loc.containerId)[loc.index].id).toBe('s0');
  });
});

describe('resolveDrop — new block from the library', () => {
  const drag: ActiveDrag = { kind: 'new', typeId: 'core/heading', label: 'Heading', Icon: () => null };

  it('inserts at the gap index at top level', () => {
    const t: DropTarget = { containerId: 'root', index: 1 };
    expect(resolveDrop(tree, drag, t)).toEqual({
      action: 'add', typeId: 'core/heading', parentId: null, slotIdx: undefined, position: 1,
    });
  });

  it('inserts into a slot at the gap index', () => {
    const t: DropTarget = { containerId: 'block:cols:slot:1', index: 2 };
    expect(resolveDrop(tree, drag, t)).toEqual({
      action: 'add', typeId: 'core/heading', parentId: 'cols', slotIdx: 1, position: 2,
    });
  });
});

describe('resolveDrop — reordering an existing block', () => {
  const dragA: ActiveDrag = { kind: 'existing', blockId: 'a', label: 'a' };

  it('is a no-op when dropped just before itself', () => {
    // `a` is at index 0; the gap at 0 (before it) means "no move".
    expect(resolveDrop(tree, dragA, { containerId: 'root', index: 0 })).toBeNull();
  });

  it('is a no-op when dropped just after itself', () => {
    // gap at 1 = immediately after index-0 `a`.
    expect(resolveDrop(tree, dragA, { containerId: 'root', index: 1 })).toBeNull();
  });

  it('shifts the position down by one when moving forward in the same list', () => {
    // Move `a` (idx 0) to the gap at index 3 (end). After removing `a` the
    // target list shrinks, so the post-removal position is 2.
    expect(resolveDrop(tree, dragA, { containerId: 'root', index: 3 })).toEqual({
      action: 'move', blockId: 'a', parentId: null, slotIdx: undefined, position: 2,
    });
  });

  it('keeps the position when moving backward in the same list', () => {
    const dragCols: ActiveDrag = { kind: 'existing', blockId: 'cols', label: 'cols' };
    // Move `cols` (idx 3) to the gap at index 1 → stays 1 (source is after it).
    expect(resolveDrop(tree, dragCols, { containerId: 'root', index: 1 })).toEqual({
      action: 'move', blockId: 'cols', parentId: null, slotIdx: undefined, position: 1,
    });
  });

  it('re-parents into another container at the gap index (no shift)', () => {
    // Move top-level `a` into c's children at gap 1 → cross-container, position 1.
    expect(resolveDrop(tree, dragA, { containerId: 'block:c:children', index: 1 })).toEqual({
      action: 'move', blockId: 'a', parentId: 'c', slotIdx: undefined, position: 1,
    });
  });
});
