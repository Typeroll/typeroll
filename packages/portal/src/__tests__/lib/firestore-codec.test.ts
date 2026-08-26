// Firestore rejects directly-nested arrays (`INVALID_ARGUMENT: Property
// array contains an invalid nested entity`) — Block.slots is Block[][], so
// every slots-bearing tree 500'd in production while passing on the JSON
// fixtures backend. The codec must make the round-trip lossless and the
// encoded form free of array-in-array.

import { describe, it, expect } from 'vitest';
import { encodeNestedArrays, decodeNestedArrays } from '../../lib/firestore-codec';

/** Deep-scan: true if any array directly contains an array (the shape Firestore rejects). */
function hasNestedArray(v: unknown): boolean {
  if (Array.isArray(v)) {
    return v.some((el) => Array.isArray(el) || hasNestedArray(el));
  }
  if (v !== null && typeof v === 'object') {
    return Object.values(v as Record<string, unknown>).some(hasNestedArray);
  }
  return false;
}

const SLOTS_PAGE = {
  title: 'Landning',
  content_mode: 'blocks',
  blocks: [
    {
      id: 'blk_cols', type: 'core/columns', data: { ratio: '1-1' },
      slots: [
        [{ id: 'blk_l', type: 'core/prose', data: { html: '<p>vänster</p>' } }],
        [
          { id: 'blk_r1', type: 'core/heading', data: { text: 'Höger', level: 'h2' } },
          {
            id: 'blk_r2', type: 'core/columns', data: {},
            slots: [[{ id: 'blk_deep', type: 'core/prose', data: { html: '<p>djup</p>' } }], []],
          },
        ],
      ],
    },
  ],
};

describe('firestore nested-array codec', () => {
  it('encoded output contains no directly-nested arrays', () => {
    expect(hasNestedArray(SLOTS_PAGE)).toBe(true); // sanity: input has the bad shape
    expect(hasNestedArray(encodeNestedArrays(SLOTS_PAGE))).toBe(false);
  });

  it('round-trips a slots-bearing block tree losslessly', () => {
    const encoded = encodeNestedArrays(structuredClone(SLOTS_PAGE));
    expect(decodeNestedArrays(encoded)).toEqual(SLOTS_PAGE);
  });

  it('leaves slot-free documents untouched', () => {
    const doc = {
      title: 'Plain', tags: ['a', 'b'],
      blocks: [{ id: 'b1', type: 'core/section', data: {}, children: [{ id: 'b2', type: 'core/prose', data: { html: '<p>x</p>' } }] }],
      nested: { deep: { list: [1, 2, 3] } },
    };
    expect(encodeNestedArrays(structuredClone(doc))).toEqual(doc);
    expect(decodeNestedArrays(structuredClone(doc))).toEqual(doc);
  });

  it('handles empty slots and scalar edge cases', () => {
    const doc = { slots: [[], []], mixed: [1, 'two', null, [true]], empty: [], nil: null };
    const enc = encodeNestedArrays(structuredClone(doc));
    expect(hasNestedArray(enc)).toBe(false);
    expect(decodeNestedArrays(enc)).toEqual(doc);
  });

  it('does not recurse into non-plain objects (Date, class instances)', () => {
    const d = new Date('2026-01-01T00:00:00Z');
    const doc = { when: d, list: [d] };
    const enc = encodeNestedArrays(doc) as typeof doc;
    expect(enc.when).toBe(d);
    expect(enc.list[0]).toBe(d);
  });
});

describe('marker field name is legal in Firestore', () => {
  it('does not use a reserved __dunder__ key', () => {
    const encoded = encodeNestedArrays([[1]]) as unknown as Array<Record<string, unknown>>;
    const markerKey = Object.keys(encoded[0])[0];
    // Firestore reserves field names matching __.*__ — the original codec
    // shipped with '__tr_nested_array__' and every slots write 500'd with
    // "field name … is reserved".
    expect(markerKey).not.toMatch(/^__.*__$/);
  });
});
