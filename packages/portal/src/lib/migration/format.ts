// The export file of the one-time store migration (Firestore → Durable Objects).
//
// An export is two files:
//   <name>.ndjson          one record per line, `{"data":…,"path":…}`, in
//                          canonical JSON, ordered by `comparePaths`
//   <name>.manifest.json   counts and SHA-256 checksums (see ExportManifest)
//
// Canonical JSON: object keys sorted by UTF-16 code unit (JavaScript's default
// sort), no whitespace, strings and numbers as JSON.stringify writes them,
// undefined object fields omitted and undefined array items written as null.
// Because every line is canonical, the overall checksum is simply the SHA-256
// of the file, so `shasum -a 256` verifies a copy without this tool.
//
// Record data is the document exactly as stored, never decrypted: Firestore
// codec markers (`_tr_nested_array_`, `_tr_blocks_gz_`, `_tr_snapshot_json_`)
// stay in place and Firestore-native values become tagged single-key objects:
//   Timestamp        {"_tr_fs_timestamp_":{"nanoseconds":n,"seconds":s}}
//   Bytes            {"_tr_fs_bytes_":"<base64>"}
//   GeoPoint         {"_tr_fs_geopoint_":{"latitude":x,"longitude":y}}
//   DocumentReference {"_tr_fs_reference_":"<path>"}
//   NaN / ±Infinity  {"_tr_fs_number_":"NaN"|"Infinity"|"-Infinity"}
// The import converts them to the SQL store's JSON representation (transform.ts).

import { createHash, type Hash } from 'node:crypto';

export const EXPORT_FORMAT = 'typeroll-store-export';
export const EXPORT_VERSION = 1;

export interface ExportRecord { path: string; data: Record<string, unknown> }

export interface ExportManifest {
  format: typeof EXPORT_FORMAT;
  version: typeof EXPORT_VERSION;
  created_at: string;
  source: string;
  records: number;
  bytes: number;
  /** SHA-256 of the whole NDJSON file. */
  sha256: string;
  /** Per collection group (collection ids without document ids, e.g. `organizations/sites/versions/pages`). */
  collections: Record<string, { count: number; sha256: string }>;
  /** Organization ids and `org/site` pairs that own documents; the import creates site objects for them first. */
  organizations: string[];
  sites: string[];
  /** Firestore-native values found, by tag. */
  firestore_types: Record<string, number>;
}

export const FS_TAGS = {
  timestamp: '_tr_fs_timestamp_',
  bytes: '_tr_fs_bytes_',
  geopoint: '_tr_fs_geopoint_',
  reference: '_tr_fs_reference_',
  number: '_tr_fs_number_',
} as const;

export const isPlainObject = (value: unknown): value is Record<string, any> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  switch (typeof value) {
    case 'string': return JSON.stringify(value);
    case 'boolean': return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new Error('Canonical JSON cannot hold a non-finite number');
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
      if (!isPlainObject(value)) throw new Error(`Canonical JSON cannot hold ${value.constructor?.name ?? 'this object'}`);
      const keys = Object.keys(value).filter(key => value[key] !== undefined).sort();
      return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
    }
  }
  throw new Error(`Canonical JSON cannot hold a ${typeof value}`);
}

export const recordLine = (record: ExportRecord) => canonicalJson({ path: record.path, data: record.data });

/** Segment-wise order: a document comes before its subcollections, siblings by id. */
export function comparePaths(a: string, b: string): number {
  const left = a.split('/'), right = b.split('/');
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    if (left[i] !== right[i]) return left[i]! < right[i]! ? -1 : 1;
  }
  return left.length - right.length;
}

/** `organizations/o/sites/s/versions/main` → `organizations/sites/versions`. */
export function collectionGroup(path: string): string {
  return path.split('/').filter((_, i) => i % 2 === 0).join('/');
}

export function isDocumentPath(path: unknown): path is string {
  if (typeof path !== 'string') return false;
  const parts = path.split('/');
  return parts.length >= 2 && parts.length % 2 === 0 && parts.every(part => part && part !== '.' && part !== '..');
}

/** Raw Firestore field values → JSON with tags; throws on a type it cannot keep. */
export function encodeStoredValue(value: unknown, types: Record<string, number> = {}): unknown {
  const count = (tag: string) => { types[tag] = (types[tag] ?? 0) + 1; };
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (value === undefined) return undefined;
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return value;
    count('number');
    return { [FS_TAGS.number]: String(value) };
  }
  if (Array.isArray(value)) return value.map(item => encodeStoredValue(item, types));
  if (value instanceof Uint8Array) { count('bytes'); return { [FS_TAGS.bytes]: Buffer.from(value).toString('base64') }; }
  if (isPlainObject(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) if (item !== undefined) result[key] = encodeStoredValue(item, types);
    return result;
  }
  const object = value as Record<string, any>;
  const kind = object.constructor?.name;
  if (typeof object.seconds === 'number' && typeof object.nanoseconds === 'number' && (kind === 'Timestamp' || typeof object.toMillis === 'function')) {
    count('timestamp');
    return { [FS_TAGS.timestamp]: { seconds: object.seconds, nanoseconds: object.nanoseconds } };
  }
  if (typeof object.latitude === 'number' && typeof object.longitude === 'number' && kind === 'GeoPoint') {
    count('geopoint');
    return { [FS_TAGS.geopoint]: { latitude: object.latitude, longitude: object.longitude } };
  }
  if (typeof object.path === 'string' && kind === 'DocumentReference') { count('reference'); return { [FS_TAGS.reference]: object.path }; }
  if (value instanceof Date) { count('timestamp'); return { [FS_TAGS.timestamp]: { seconds: Math.floor(value.valueOf() / 1000), nanoseconds: (value.valueOf() % 1000) * 1e6 } }; }
  throw new Error(`Unsupported stored value: ${kind ?? typeof value}`);
}

/** Accumulates the manifest while lines are written or re-read. */
export class ManifestBuilder {
  private readonly overall = createHash('sha256');
  private readonly groups = new Map<string, { count: number; hash: Hash }>();
  private readonly organizations = new Set<string>();
  private readonly sites = new Set<string>();
  private records = 0;
  private bytes = 0;
  private last: string | null = null;

  /** Add one canonical line (without its newline) for `path`; refuses unordered or duplicate paths. */
  add(path: string, line: string): void {
    if (this.last !== null && comparePaths(this.last, path) >= 0) throw new Error(`Records out of order: ${path} after ${this.last}`);
    this.last = path;
    const text = `${line}\n`;
    this.overall.update(text);
    this.bytes += Buffer.byteLength(text);
    this.records++;
    const name = collectionGroup(path);
    let group = this.groups.get(name);
    if (!group) { group = { count: 0, hash: createHash('sha256') }; this.groups.set(name, group); }
    group.count++;
    group.hash.update(text);
    const site = path.match(/^organizations\/([^/]+)\/sites\/([^/]+)/);
    const org = path.match(/^organizations\/([^/]+)/);
    if (org) this.organizations.add(org[1]!);
    if (site) this.sites.add(`${site[1]}/${site[2]}`);
  }

  finish(meta: { source: string; createdAt: string; firestoreTypes?: Record<string, number> }): ExportManifest {
    const collections: ExportManifest['collections'] = {};
    for (const name of [...this.groups.keys()].sort()) {
      const group = this.groups.get(name)!;
      collections[name] = { count: group.count, sha256: group.hash.digest('hex') };
    }
    return {
      format: EXPORT_FORMAT, version: EXPORT_VERSION, created_at: meta.createdAt, source: meta.source,
      records: this.records, bytes: this.bytes, sha256: this.overall.digest('hex'), collections,
      organizations: [...this.organizations].sort(), sites: [...this.sites].sort(),
      firestore_types: Object.fromEntries(Object.entries(meta.firestoreTypes ?? {}).sort()),
    };
  }
}

/** Parse one export line; null with a reason when it is not a well-formed canonical record. */
export function parseRecordLine(text: string): { record: ExportRecord } | { error: string } {
  let parsed: any;
  try { parsed = JSON.parse(text); } catch { return { error: 'invalid JSON' }; }
  if (!isPlainObject(parsed) || !isDocumentPath(parsed.path) || !isPlainObject(parsed.data) || Object.keys(parsed).length !== 2)
    return { error: 'not a {path, data} record' };
  if (canonicalJson(parsed) !== text) return { error: 'not canonical JSON' };
  return { record: parsed as ExportRecord };
}

/** Split a byte stream into lines (UTF-8, `\n`), without the newline. */
export async function* readLines(chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let pending = '';
  for await (const chunk of chunks) {
    pending += decoder.decode(chunk, { stream: true });
    let index: number;
    while ((index = pending.indexOf('\n')) >= 0) { yield pending.slice(0, index); pending = pending.slice(index + 1); }
  }
  pending += decoder.decode();
  if (pending) yield pending;
}

export interface VerifyResult { ok: boolean; problems: string[]; manifest: ExportManifest | null }

/** Recompute an export's manifest from its lines and compare it with the stored one. */
export async function verifyExport(lines: AsyncIterable<string>, manifest: ExportManifest): Promise<VerifyResult> {
  const problems: string[] = [];
  if (manifest.format !== EXPORT_FORMAT || manifest.version !== EXPORT_VERSION) return { ok: false, problems: [`unsupported manifest ${manifest.format}@${manifest.version}`], manifest: null };
  const builder = new ManifestBuilder();
  let line = 0;
  for await (const text of lines) {
    line++;
    const parsed = parseRecordLine(text);
    if ('error' in parsed) { problems.push(`line ${line}: ${parsed.error}`); continue; }
    try { builder.add(parsed.record.path, text); } catch (error) { problems.push(`line ${line}: ${(error as Error).message}`); }
  }
  const actual = builder.finish({ source: manifest.source, createdAt: manifest.created_at, firestoreTypes: manifest.firestore_types });
  if (actual.records !== manifest.records) problems.push(`records: expected ${manifest.records}, found ${actual.records}`);
  for (const name of new Set([...Object.keys(manifest.collections), ...Object.keys(actual.collections)])) {
    const expected = manifest.collections[name], found = actual.collections[name];
    if (!expected || !found) problems.push(`collection ${name}: ${expected ? 'missing from the file' : 'not in the manifest'}`);
    else if (expected.count !== found.count) problems.push(`collection ${name}: expected ${expected.count} records, found ${found.count}`);
    else if (expected.sha256 !== found.sha256) problems.push(`collection ${name}: checksum differs`);
  }
  if (actual.sha256 !== manifest.sha256) problems.push('file checksum differs');
  return { ok: problems.length === 0, problems, manifest: actual };
}
