import { describe, it, expect } from 'vitest';
import { ensureBlockIds } from '../block-ids.js';
import type { Block } from '../types.js';

describe('ensureBlockIds', () => {
  it('assigns ids deeply (children + slots), keeps existing ones', () => {
    const tree = [
      { id: 'keep-me', type: 'core/section', data: {}, children: [
        { type: 'core/prose', data: {} },
      ] },
      { type: 'core/columns', data: {}, slots: [
        [{ type: 'core/prose', data: {} }],
        [{ type: 'core/prose', data: {} }],
      ] },
    ] as unknown as Block[];
    ensureBlockIds(tree);
    expect(tree[0].id).toBe('keep-me');
    expect(tree[0].children![0].id).toMatch(/^blk_/);
    expect(tree[1].id).toMatch(/^blk_/);
    expect(tree[1].slots![0][0].id).toMatch(/^blk_/);
    expect(tree[1].slots![1][0].id).toMatch(/^blk_/);
  });

  it('re-assigns duplicate ids, keeping the first occurrence', () => {
    const tree = [
      { id: 'dup', type: 'core/prose', data: {} },
      { id: 'dup', type: 'core/prose', data: {} },
    ] as unknown as Block[];
    ensureBlockIds(tree);
    expect(tree[0].id).toBe('dup');
    expect(tree[1].id).not.toBe('dup');
  });

  it('tolerates null/undefined input', () => {
    expect(ensureBlockIds(undefined)).toEqual([]);
    expect(ensureBlockIds(null)).toEqual([]);
  });
});
