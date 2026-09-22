// A write that stores a key nothing will ever read should say so.
//
// style_overrides: { class: 'x' } answered 200 with saved: true, stored the
// key, survived the build and the deploy, and never reached the markup —
// because the renderer reads custom_class. The only signal was a rendered
// pixel that was the wrong colour.

import { describe, expect, it } from 'vitest';
import { blockTreeWarnings, STYLE_OVERRIDE_KEYS, styleOverrideWarnings } from '@typeroll/shared';

const block = (over: Record<string, unknown> = {}) => ({ id: 'b1', type: 'core/prose', ...over });

describe('unknown style overrides', () => {
  it('names the exact key, where it is, and what is accepted', () => {
    const [warning] = blockTreeWarnings([block({ style_overrides: { class: 'moveria-home' } })]);
    expect(warning).toMatchObject({ code: 'unknown_style_override', block_id: 'b1', key: 'class' });
    expect(warning!.path).toBe('blocks[0].style_overrides.class');
    // The message carries the whole accepted set, so the fix needs no lookup.
    expect(warning!.message).toContain('custom_class');
  });

  it('says nothing about the keys the renderer actually reads', () => {
    const clean = Object.fromEntries(STYLE_OVERRIDE_KEYS.map((k) => [k, 'v']));
    expect(blockTreeWarnings([block({ style_overrides: clean })])).toEqual([]);
  });

  it('finds them nested in children and slots, not only at the top', () => {
    const tree = [block({
      id: 'root',
      children: [block({ id: 'kid', style_overrides: { klass: 'x' } })],
      slots: [[block({ id: 'slotted', style_overrides: { Class: 'y' } })]],
    })];
    const found = blockTreeWarnings(tree);
    expect(found.map((w) => w.block_id).sort()).toEqual(['kid', 'slotted']);
    // Case matters: the renderer reads custom_class, not Class.
    expect(found.map((w) => w.key).sort()).toEqual(['Class', 'klass']);
  });

  it('reports every offending key rather than stopping at the first', () => {
    // A caller fixing one typo should not have to write again to find the next.
    const found = blockTreeWarnings([block({ style_overrides: { class: 'a', id: 'b', custom_class: 'ok' } })]);
    expect(found.map((w) => w.key).sort()).toEqual(['class', 'id']);
  });

  it('is quiet on trees with no overrides, and on nothing at all', () => {
    expect(blockTreeWarnings([block()])).toEqual([]);
    expect(blockTreeWarnings(undefined)).toEqual([]);
    expect(blockTreeWarnings([])).toEqual([]);
  });

  it('does not warn about block data, where unknown fields are forward compatibility', () => {
    // A block type's fields vary and evolve; only style_overrides is a closed
    // set the renderer enumerates in one place.
    expect(blockTreeWarnings([block({ data: { invented_field: 'y' } })])).toEqual([]);
  });

  it('survives a tree that refers to itself', () => {
    const loop: Record<string, unknown> = { id: 'loop', type: 'core/prose', style_overrides: { class: 'x' } };
    loop.children = [loop];
    expect(() => blockTreeWarnings([loop])).not.toThrow();
    expect(blockTreeWarnings([loop])).toHaveLength(1);
  });
});

describe('a single-block write', () => {
  it('warns on an unknown override, naming the block rather than a tree index', () => {
    // The discovery path for this defect was a one-block PATCH, and those
    // routes take style_overrides directly rather than as a tree — so the tree
    // walker never saw the write where the mistake is easiest to make.
    const warnings = styleOverrideWarnings({ class: 'moveria-home' }, 'blk_1');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.key).toBe('class');
    expect(warnings[0]!.block_id).toBe('blk_1');
    expect(warnings[0]!.path).toBe('blk_1.style_overrides.class');
    // The message names what to use instead, since `class` for `custom_class`
    // is exactly what a caller produces from memory.
    expect(warnings[0]!.message).toContain('custom_class');
  });

  it('is silent on the keys the renderer actually reads', () => {
    expect(styleOverrideWarnings({ custom_class: 'x', html_id: 'y' }, 'blk_1')).toEqual([]);
  });

  it('reports every unknown key, not just the first', () => {
    const warnings = styleOverrideWarnings({ class: 'a', not_a_real_key: 'b' }, 'blk_1');
    expect(warnings.map((w) => w.key).sort()).toEqual(['class', 'not_a_real_key']);
  });

  it('ignores a missing or non-object value rather than throwing', () => {
    for (const value of [undefined, null, 'string', ['array']])
      expect(styleOverrideWarnings(value, 'blk_1')).toEqual([]);
  });
});
