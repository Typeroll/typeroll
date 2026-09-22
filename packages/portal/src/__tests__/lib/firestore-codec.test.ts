// Firestore rejects directly-nested arrays (`INVALID_ARGUMENT: Property
// array contains an invalid nested entity`) — Block.slots is Block[][], so
// every slots-bearing tree 500'd in production while passing on the JSON
// fixtures backend. The codec must make the round-trip lossless and the
// encoded form free of array-in-array.

import { describe, it, expect } from 'vitest';
import { encodeNestedArrays, decodeNestedArrays, encodeFirestoreDocument } from '../../lib/firestore-codec';

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

describe('Firestore history snapshots', () => {
  it('round-trips revision and provenance payloads without adding tree depth', async () => {
    const { encodeFirestoreDocument } = await import('../../lib/firestore-codec');
    for (const [collection, payload] of [
      ['revisions', { kind: 'page', doc: SLOTS_PAGE }],
      ['answer_history', { actor: 'owner', before: SLOTS_PAGE, after: { ...SLOTS_PAGE, title: 'Updated' } }],
    ] as const) {
      const encoded = encodeFirestoreDocument(`sites/site/${collection}/entry`, payload);
      expect(decodeNestedArrays(encoded)).toEqual(payload);
      expect(JSON.stringify(encoded)).toContain('_tr_snapshot_json_');
      expect(decodeNestedArrays(encodeNestedArrays(payload))).toEqual(payload);
    }
    expect(encodeFirestoreDocument('sites/site/pages/home', { doc: { title: 'Ordinary field' } })).toEqual({ doc: { title: 'Ordinary field' } });
  });

  it('rejects invalid document depth and cycles with a field locator', async () => {
    const { encodeFirestoreDocument, StorageDocumentError } = await import('../../lib/firestore-codec');
    let deep: any = { value: 1 };
    for (let n = 0; n < 22; n++) deep = { nested: deep };
    expect(() => encodeFirestoreDocument('pages/home', deep)).toThrow(StorageDocumentError);
    try { encodeFirestoreDocument('pages/home', deep); } catch (error: any) {
      expect(error.code).toBe('storage_document_too_deep'); expect(error.field).toContain('nested.');
    }
    const cycle: any = {}; cycle.child = cycle;
    expect(() => encodeFirestoreDocument('pages/home', cycle)).toThrow(/circular/);
    expect(() => encodeFirestoreDocument('revisions/entry', { doc: cycle })).toThrow(/circular/);
  });

  it('rejects unreadable snapshots without echoing their contents', () => {
    expect(() => decodeNestedArrays({ doc: { _tr_snapshot_json_: 'private-corrupt-payload' } })).toThrow('This history snapshot could not be read.');
  });
});

describe('block trees are stored as content, not as structure', () => {
  // The composition that could not be saved: moveria-se's footer sits at
  // Firestore's nesting ceiling, so the draft envelope pushed it one level over
  // and an ordinary edit was rejected. Depth is measured here the way the codec
  // measures it, against the encoded document.
  const deepest = (value: unknown, segs: string[] = [], best = { n: 0 }): number => {
    if (segs.length > best.n) best.n = segs.length;
    if (value && typeof value === 'object') {
      for (const [k, child] of Object.entries(value)) deepest(child, [...segs, k], best);
    }
    return best.n;
  };
  /**
   * A block tree `levels` deep, alternating `children` and `slots` so it
   * exercises the array-in-array shape at depth. One branch per level: a tree
   * that forks on both keys is 2^levels nodes, which is a test that measures
   * the machine rather than the codec.
   */
  const tree = (levels: number): any =>
    levels === 0
      ? [{ id: 'leaf', type: 'core/prose', data: { html: '<p>x</p>' } }]
      : levels % 2 === 0
        ? [{ id: `l${levels}`, type: 'core/container', slots: [tree(levels - 1)] }]
        : [{ id: `l${levels}`, type: 'core/container', children: tree(levels - 1) }];

  it('stores a tree far deeper than Firestore would accept', () => {
    const encoded = encodeFirestoreDocument('o/1/sites/s/versions/main/pages/p', { blocks: tree(40) });
    // 40 levels is comfortably past the limit as native maps; compressed it is flat.
    expect(deepest(encoded)).toBeLessThan(5);
    expect(decodeNestedArrays(encoded)).toEqual({ blocks: tree(40) });
  });

  it('accepts a draft of a tree that sits at the ceiling', () => {
    // This is the exact shape that failed: the same tree one level down, under
    // the working copy's `fields` envelope.
    const blocks = tree(18);
    expect(() => encodeFirestoreDocument(
      'o/1/sites/s/versions/main/working_copies/partial:header',
      { kind: 'partial', fields: { blocks } },
    )).not.toThrow();
    const encoded = encodeFirestoreDocument(
      'o/1/sites/s/versions/main/working_copies/partial:header',
      { kind: 'partial', fields: { blocks } },
    );
    expect((decodeNestedArrays(encoded) as any).fields.blocks).toEqual(blocks);
  });

  it('round-trips the nested arrays that made the codec necessary', () => {
    // Block.slots is Block[][], the shape Firestore rejects outright.
    const blocks = [{ id: 'a', slots: [[{ id: 'b' }], [{ id: 'c' }]] }];
    const encoded = encodeFirestoreDocument('o/1/sites/s/versions/main/partials/header', { blocks });
    expect(decodeNestedArrays(encoded)).toEqual({ blocks });
  });

  it('does not mutate the document it was given', () => {
    const doc = { kind: 'partial', fields: { blocks: tree(3) } };
    const before = JSON.stringify(doc);
    encodeFirestoreDocument('o/1/sites/s/versions/main/working_copies/partial:header', doc);
    expect(JSON.stringify(doc)).toBe(before);
    expect(Array.isArray(doc.fields.blocks)).toBe(true);
  });

  it('leaves a document carrying no blocks untouched', () => {
    const doc = { name: 'Header', content_mode: 'html', html_content: '<nav/>' };
    expect(decodeNestedArrays(encodeFirestoreDocument('o/1/sites/s/versions/main/partials/header', doc))).toEqual(doc);
  });

  it('still reads a tree written before compression existed', () => {
    // Existing documents hold native arrays. They must keep reading, because
    // nothing rewrites them until their page is next saved.
    const legacy = { blocks: [{ id: 'a', children: [{ id: 'b' }] }] };
    expect(decodeNestedArrays(legacy)).toEqual(legacy);
  });

  it('does not compress a revision snapshot twice', () => {
    const encoded = encodeFirestoreDocument('o/1/sites/s/revisions/r1', { doc: { blocks: tree(3) } }) as any;
    expect(typeof encoded.doc._tr_snapshot_json_).toBe('string');
    expect(encoded.doc._tr_blocks_gz_).toBeUndefined();
  });

  it('reports unreadable stored content instead of returning a partial tree', () => {
    expect(() => decodeNestedArrays({ blocks: { _tr_blocks_gz_: 'not-gzip' } }))
      .toThrow(/could not be read/);
  });
});
