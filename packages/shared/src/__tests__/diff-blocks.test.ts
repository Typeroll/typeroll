// diffBlocks — the "review changes" engine. Matched by stable block id;
// added/removed report subtree ROOTS only; changed lists the differing
// data fields; moved fires on parent/slot/index changes.

import { describe, it, expect } from 'vitest';
import { diffBlocks } from '../diff-blocks.js';
import type { Block } from '../types.js';

const B = (id: string, over: Partial<Block> = {}): Block =>
  ({ id, type: 'core/prose', data: { text: 'x' }, ...over } as Block);

describe('diffBlocks', () => {
  it('empty diff for identical trees', () => {
    const tree = [B('a'), B('sec', { type: 'core/section', children: [B('c1')] })];
    expect(diffBlocks(tree, structuredClone(tree))).toEqual([]);
  });

  it('added subtree reports the root only', () => {
    const before = [B('a')];
    const after = [B('a'), B('sec', { type: 'core/section', children: [B('c1'), B('c2')] })];
    const changes = diffBlocks(before, after);
    expect(changes).toEqual([
      expect.objectContaining({ kind: 'added', block_id: 'sec', type: 'core/section' }),
    ]);
  });

  it('removed subtree reports the root only', () => {
    const before = [B('a'), B('sec', { type: 'core/section', children: [B('c1')] })];
    const changes = diffBlocks(before, [B('a')]);
    expect(changes).toEqual([
      expect.objectContaining({ kind: 'removed', block_id: 'sec' }),
    ]);
  });

  it('changed lists the differing data fields, sorted, and detects renames', () => {
    const before = [B('a', { data: { text: 'old', size: 'md' }, name: 'Intro' })];
    const after = [B('a', { data: { text: 'new', size: 'md', align: 'center' }, name: 'Ingress' })];
    const changes = diffBlocks(before, after);
    expect(changes).toEqual([
      expect.objectContaining({ kind: 'changed', block_id: 'a', fields: ['align', 'text', 'name'] }),
    ]);
  });

  it('reorder within a container is a move', () => {
    const before = [B('a'), B('b')];
    const changes = diffBlocks(before, [B('b'), B('a')]);
    expect(changes).toHaveLength(2);
    expect(changes.every((c) => c.kind === 'moved')).toBe(true);
    const a = changes.find((c) => c.block_id === 'a')!;
    expect(a.from).toBe('root[0]');
    expect(a.to).toBe('root[1]');
  });

  it('reparenting (incl. slot moves) is a move with readable paths', () => {
    const before = [
      B('cols', { type: 'core/columns', slots: [[B('x')], []] }),
    ];
    const after = [
      B('cols', { type: 'core/columns', slots: [[], [B('x')]] }),
    ];
    const changes = diffBlocks(before, after);
    expect(changes).toEqual([
      expect.objectContaining({ kind: 'moved', block_id: 'x', from: 'cols.slot0[0]', to: 'cols.slot1[0]' }),
    ]);
  });

  it('a block can be both changed and moved', () => {
    const before = [B('a'), B('b')];
    const after = [B('b'), B('a', { data: { text: 'edited' } })];
    const kinds = diffBlocks(before, after).filter((c) => c.block_id === 'a').map((c) => c.kind).sort();
    expect(kinds).toEqual(['changed', 'moved']);
  });

  it('responsive object values compare deeply', () => {
    const before = [B('g', { type: 'core/grid', data: { cols: { mobile: 1, laptop: 3 } } })];
    const sameAfter = [B('g', { type: 'core/grid', data: { cols: { mobile: 1, laptop: 3 } } })];
    expect(diffBlocks(before, sameAfter)).toEqual([]);
    const changedAfter = [B('g', { type: 'core/grid', data: { cols: { mobile: 1, laptop: 4 } } })];
    expect(diffBlocks(before, changedAfter)).toEqual([
      expect.objectContaining({ kind: 'changed', fields: ['cols'] }),
    ]);
  });
});
