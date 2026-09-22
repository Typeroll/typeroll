// A write that stores a key nothing will ever read should say so.
//
// style_overrides: { class: 'x' } answered 200 with saved: true, stored the
// key, survived the build and the deploy, and never reached the markup —
// because the renderer reads custom_class. The only signal was a rendered
// pixel that was the wrong colour.

import { describe, expect, it } from 'vitest';
import { blockTreeWarnings, STYLE_OVERRIDE_KEYS } from '@typeroll/shared';

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
