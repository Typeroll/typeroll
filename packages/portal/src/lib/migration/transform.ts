// What the import does to an exported record before writing it.
//
// 1. Records of collections that no longer exist, and the store-internal ones
//    of a sharded export, are dropped (DROPPED).
// 2. Firestore-native values become what the SQL store would have stored had
//    the same value been written through it (JSON.stringify semantics):
//    Timestamp → ISO-8601 string with millisecond precision (as a Date
//    serializes), Bytes → base64 string, GeoPoint → {latitude, longitude},
//    DocumentReference → its path, NaN/±Infinity → null.
// 3. Firestore codec markers are decoded: nested arrays are unwrapped, history
//    snapshots become objects again and gzip-wrapped block trees become plain
//    JSON. A document whose decoded JSON exceeds `maxDocumentBytes` (the
//    Durable Object row limit is 2 MB) keeps its stored encoding instead and is
//    reported, so a reader must still decode it with `decodeNestedArrays`.
// 4. An `id` field equal to the document id is removed: every store returns the
//    document id as `id`. A different `id` field is kept and reported, because
//    the SQL store cannot keep it (the compare then reports the document).

import { decodeNestedArrays } from '../firestore-codec';
import { FS_TAGS, isPlainObject, type ExportRecord } from './format';

/** The Durable Object SQLite row limit is 2 MB; leave room for the path and columns. */
export const MAX_DOCUMENT_BYTES = 2_000_000;

export const DROPPED: ReadonlyArray<{ prefix: string; reason: string }> = [
  { prefix: 'revoked_sessions/', reason: 'Firebase session denylist; Better Auth database sessions replace it' },
  { prefix: 'session_lineage/', reason: 'Firebase session lineage; Better Auth database sessions replace it' },
  { prefix: 'auth_rate_limits/', reason: 'short-lived rate-limit windows' },
  { prefix: 'typeroll_system/deploy_queue', reason: 'Firestore deploy queue; scheduling uses scheduled_work and the Scheduler objects' },
  { prefix: '_outbox/', reason: 'store-internal outbox' },
  // Present only in exports of a sharded store: the target names its own site objects.
  { prefix: 'site_owners/', reason: 'site object names are assigned by the target store' },
];

export function droppedReason(path: string): string | null {
  for (const rule of DROPPED) {
    if (path.startsWith(rule.prefix) && (rule.prefix.endsWith('/') || path === rule.prefix || path.startsWith(`${rule.prefix}/`))) return rule.reason;
  }
  return null;
}

export type Transformed =
  | { kind: 'drop'; path: string; reason: string }
  | { kind: 'write'; path: string; data: Record<string, any>; compressed: boolean; idMismatch: boolean }
  | { kind: 'error'; path: string; error: string };

const tagOf = (value: Record<string, any>) => {
  const keys = Object.keys(value);
  return keys.length === 1 && (Object.values(FS_TAGS) as string[]).includes(keys[0]!) ? keys[0]! : null;
};

/** Tagged Firestore values → the SQL store's JSON. */
export function toStoreValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toStoreValue);
  if (!isPlainObject(value)) return value;
  const tag = tagOf(value), inner = tag ? value[tag] : undefined;
  switch (tag) {
    case FS_TAGS.timestamp: return new Date(inner.seconds * 1000 + Math.floor(inner.nanoseconds / 1e6)).toISOString();
    case FS_TAGS.bytes: return inner;
    case FS_TAGS.geopoint: return { latitude: inner.latitude, longitude: inner.longitude };
    case FS_TAGS.reference: return inner;
    case FS_TAGS.number: return null;
  }
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) result[key] = toStoreValue(item);
  return result;
}

const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

export function transformRecord(record: ExportRecord, opts: { maxDocumentBytes?: number } = {}): Transformed {
  const { path } = record, limit = opts.maxDocumentBytes ?? MAX_DOCUMENT_BYTES;
  const reason = droppedReason(path);
  if (reason) return { kind: 'drop', path, reason };
  const stored = toStoreValue(record.data) as Record<string, any>;
  let data: Record<string, any>, compressed = false;
  try { data = decodeNestedArrays(stored); }
  catch (error) { return { kind: 'error', path, error: (error as { code?: string }).code ?? 'undecodable' }; }
  if (size(data) > limit) { data = stored; compressed = true; }
  if (size(data) > limit) return { kind: 'error', path, error: `larger than ${limit} bytes even compressed` };
  const id = path.slice(path.lastIndexOf('/') + 1);
  let idMismatch = false;
  if (Object.hasOwn(data, 'id')) {
    if (data.id === id) { const { id: _id, ...rest } = data; void _id; data = rest; }
    else idMismatch = true;
  }
  return { kind: 'write', path, data, compressed, idMismatch };
}

/** The value a reader sees, for comparisons: codec markers decoded, the document id not part of the data. */
export function logicalValue(path: string, value: Record<string, any>): Record<string, any> {
  const decoded = decodeNestedArrays(value);
  if (decoded.id === path.slice(path.lastIndexOf('/') + 1)) { const { id: _id, ...rest } = decoded; void _id; return rest; }
  return decoded;
}
