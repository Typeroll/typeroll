// The export format's building blocks: canonical JSON, path order, Firestore
// value tags and their store representation, dropped collections and stepping
// over a file by byte range.
import { describe, expect, it } from 'vitest';
import {
  bufferByteSource, canonicalJson, collectionGroup, comparePaths, droppedReason, encodeStoredValue, firstDifference,
  parseRecordLine, r2ByteSource, readStep, toStoreValue, transformRecord,
} from '../../lib/migration';

describe('canonical JSON', () => {
  it('sorts keys at every level and omits undefined fields', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, undefined, 'x'], c: null, e: undefined } })).toBe('{"a":{"c":null,"d":[1,null,"x"]},"b":1}');
    expect(canonicalJson({ Z: 1, a: 2, _: 3 })).toBe('{"Z":1,"_":3,"a":2}');
  });

  it('refuses values JSON cannot hold', () => {
    expect(() => canonicalJson({ n: Number.NaN })).toThrow(/non-finite/);
    expect(() => canonicalJson({ d: new Date(0) })).toThrow(/Date/);
  });

  it('accepts only canonical {path, data} lines', () => {
    expect(parseRecordLine('{"data":{"a":1},"path":"c/d"}')).toEqual({ record: { path: 'c/d', data: { a: 1 } } });
    expect(parseRecordLine('{"path":"c/d","data":{"a":1}}')).toEqual({ error: 'not canonical JSON' });
    expect(parseRecordLine('{"data":{},"path":"c"}')).toEqual({ error: 'not a {path, data} record' });
    expect(parseRecordLine('{"data":{},"path":"c/d","x":1}')).toEqual({ error: 'not a {path, data} record' });
  });
});

describe('paths', () => {
  it('orders a document before its subcollections and siblings by id', () => {
    const paths = ['a/b-x', 'a/b/c/d', 'a/b', 'a/a/z/z', 'b/a', 'a/B'];
    expect([...paths].sort(comparePaths)).toEqual(['a/B', 'a/a/z/z', 'a/b', 'a/b/c/d', 'a/b-x', 'b/a']);
  });

  it('names collection groups without document ids', () => {
    expect(collectionGroup('organizations/o/sites/s/versions/main/pages/p')).toBe('organizations/sites/versions/pages');
    expect(collectionGroup('api_key_lookup/k')).toBe('api_key_lookup');
  });

  it('drops only the obsolete collections', () => {
    expect(droppedReason('revoked_sessions/x')).toMatch(/Better Auth/);
    expect(droppedReason('session_lineage/x')).toMatch(/Better Auth/);
    expect(droppedReason('auth_rate_limits/x')).toMatch(/rate-limit/);
    expect(droppedReason('typeroll_system/deploy_queue')).toMatch(/deploy queue/);
    expect(droppedReason('typeroll_system/deploy_queue/items/1')).toMatch(/deploy queue/);
    expect(droppedReason('typeroll_system/deploy_queue_other')).toBeNull();
    expect(droppedReason('typeroll_system/installation')).toBeNull();
    expect(droppedReason('site_owners/o:s')).toMatch(/assigned by the target/);
    expect(droppedReason('auth_user/u')).toBeNull();
  });
});

describe('Firestore values', () => {
  class Timestamp { constructor(readonly seconds: number, readonly nanoseconds: number) {} toMillis() { return 0; } }
  class GeoPoint { constructor(readonly latitude: number, readonly longitude: number) {} }
  class DocumentReference { constructor(readonly path: string) {} }

  it('tags native values losslessly and converts them as the SQL store would store them', () => {
    const types: Record<string, number> = {};
    const tagged = encodeStoredValue({
      at: new Timestamp(1, 5_000_000), raw: new Uint8Array([1, 2]), where: new GeoPoint(59.3, 18.1),
      ref: new DocumentReference('organizations/o'), bad: [Number.POSITIVE_INFINITY], nested: [{ at: new Timestamp(0, 0) }],
    }, types);
    expect(tagged).toEqual({
      at: { _tr_fs_timestamp_: { seconds: 1, nanoseconds: 5_000_000 } }, raw: { _tr_fs_bytes_: 'AQI=' },
      where: { _tr_fs_geopoint_: { latitude: 59.3, longitude: 18.1 } }, ref: { _tr_fs_reference_: 'organizations/o' },
      bad: [{ _tr_fs_number_: 'Infinity' }], nested: [{ at: { _tr_fs_timestamp_: { seconds: 0, nanoseconds: 0 } } }],
    });
    expect(types).toEqual({ timestamp: 2, bytes: 1, geopoint: 1, reference: 1, number: 1 });
    expect(toStoreValue(JSON.parse(canonicalJson(tagged)))).toEqual({
      at: '1970-01-01T00:00:01.005Z', raw: 'AQI=', where: { latitude: 59.3, longitude: 18.1 }, ref: 'organizations/o', bad: [null],
      nested: [{ at: '1970-01-01T00:00:00.000Z' }],
    });
  });

  it('refuses a value type it cannot keep', () => {
    expect(() => encodeStoredValue({ m: new Map() })).toThrow(/Unsupported stored value: Map/);
  });

  it('keeps an id field that differs from the document id and reports it', () => {
    expect(transformRecord({ path: 'c/d', data: { id: 'd', a: 1 } })).toMatchObject({ kind: 'write', data: { a: 1 }, idMismatch: false });
    expect(transformRecord({ path: 'c/d', data: { id: 'other' } })).toMatchObject({ kind: 'write', data: { id: 'other' }, idMismatch: true });
  });

  it('reports an undecodable block tree', () => {
    expect(transformRecord({ path: 'o/x/pages/p', data: { blocks: { _tr_blocks_gz_: 'not-gzip' } } })).toEqual({ kind: 'error', path: 'o/x/pages/p', error: 'storage_blocks_invalid' });
  });
});

describe('differences', () => {
  it('names the first differing JSON pointer without values', () => {
    expect(firstDifference({ a: [1, { 'b/c': 2 }] }, { a: [1, { 'b/c': 3 }] })).toBe('/a/1/b~1c');
    expect(firstDifference({ a: [1] }, { a: [1, 2] })).toBe('/a/length');
    expect(firstDifference({ a: 1 }, { a: 1 })).toBeNull();
    expect(firstDifference(1, 'x')).toBe('/');
  });
});

describe('steps over a file', () => {
  const file = Buffer.from('{"a":1}\n{"long":"' + 'x'.repeat(100) + '"}\n{"c":3}');

  it('returns whole lines, grows past a long line and ends without a final newline', async () => {
    const source = bufferByteSource(file);
    const first = await readStep(source, { offset: 0, line: 1 }, 16);
    expect(first.lines).toEqual([{ line: 1, text: '{"a":1}' }]);
    const second = await readStep(source, first.next, 16);
    expect(second.lines[0]).toEqual({ line: 2, text: `{"long":"${'x'.repeat(100)}"}` });
    let cursor = second.next, rest = second.lines.slice(1), done = second.done;
    while (!done) { const step = await readStep(source, cursor, 16); rest = [...rest, ...step.lines]; cursor = step.next; done = step.done; }
    expect(rest).toEqual([{ line: 3, text: '{"c":3}' }]);
    expect(cursor).toEqual({ offset: file.length, line: 4 });
    expect(await readStep(source, cursor)).toMatchObject({ lines: [], done: true });
  });

  it('reads an R2 object by byte range', async () => {
    const calls: Array<{ offset: number; length: number }> = [];
    const bucket = {
      head: async (key: string) => key === 'store.ndjson' ? { size: file.length } : null,
      get: async (_key: string, { range }: { range: { offset: number; length: number } }) => {
        calls.push(range);
        return { arrayBuffer: async () => { const slice = file.subarray(range.offset, range.offset + range.length); return slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.length) as ArrayBuffer; } };
      },
    };
    const source = await r2ByteSource(bucket, 'store.ndjson');
    const step = await readStep(source, { offset: 0, line: 1 }, 1024);
    expect(step.lines).toHaveLength(3);
    expect(calls).toEqual([{ offset: 0, length: file.length }]);
    await expect(r2ByteSource(bucket, 'missing')).rejects.toThrow(/not found/);
  });
});
