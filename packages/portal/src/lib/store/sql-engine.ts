// A document store on one SQLite database, runtime-neutral.
//
// The same engine runs inside a Cloudflare Durable Object (ctx.storage.sql)
// and on node:sqlite for local development and offline tests. It is
// synchronous on purpose: in a Durable Object, a synchronous transaction cannot
// interleave with another request, which is what makes a commit's
// preconditions and writes atomic.
//
// Conditional writes use revisions rather than callbacks. A caller reads a
// document with its revision, decides locally, and commits only if every
// document it relied on still has the revision it read. That works across an
// RPC boundary, where a predicate function cannot travel.

export interface SqlDriver {
  exec<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[];
  transaction<T>(work: () => T): T;
}

export interface Filter {
  field: string;
  op: '==' | '!=' | '<' | '<=' | '>' | '>=' | 'in';
  value: unknown;
}

export interface StoredDoc { path: string; id: string; data: Record<string, any>; revision: number }
/** `revision: null` requires the document to be absent. */
export interface Precondition { path: string; revision: number | null }
export type Write =
  | { path: string; op: 'set'; data: Record<string, any> }
  | { path: string; op: 'merge'; data: Record<string, any> }
  | { path: string; op: 'delete' };
export type CommitResult = { ok: true; seq: number } | { ok: false; conflict: string };

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS documents (path TEXT PRIMARY KEY, parent TEXT NOT NULL, id TEXT NOT NULL,
     data TEXT NOT NULL, revision INTEGER NOT NULL, seq INTEGER NOT NULL)`,
  'CREATE INDEX IF NOT EXISTS documents_parent ON documents(parent, id)',
  'CREATE INDEX IF NOT EXISTS documents_seq ON documents(seq)',
  // Deleted paths with the commit that removed them, so a snapshot can tell a
  // concurrent delete from a document that never existed.
  'CREATE TABLE IF NOT EXISTS deletions (path TEXT PRIMARY KEY, seq INTEGER NOT NULL)',
  'CREATE INDEX IF NOT EXISTS deletions_seq ON deletions(seq)',
  'CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL)',
];

/** Path segments: alternating collection/document ids, never empty, never traversal. */
export function assertDocPath(path: string): void {
  const parts = path.split('/');
  if (parts.length < 2 || parts.length % 2 !== 0 || parts.some(part => !part || part === '.' || part === '..'))
    throw new Error(`Invalid document path: ${path}`);
}
export function assertCollectionPath(path: string): void {
  const parts = path.split('/');
  if (parts.length % 2 !== 1 || parts.some(part => !part || part === '.' || part === '..'))
    throw new Error(`Invalid collection path: ${path}`);
}

const parentOf = (path: string) => path.slice(0, path.lastIndexOf('/'));
const idOf = (path: string) => path.slice(path.lastIndexOf('/') + 1);
const isPlainObject = (value: unknown): value is Record<string, any> =>
  !!value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

/** Drop undefined object fields, as Firestore does with ignoreUndefinedProperties. */
export function clean(value: any): any {
  if (Array.isArray(value)) return value.map(item => item === undefined ? null : clean(item));
  if (isPlainObject(value)) {
    const result: Record<string, any> = {};
    for (const [key, item] of Object.entries(value)) if (item !== undefined) result[key] = clean(item);
    return result;
  }
  return value;
}

/** Firestore `set(…, { merge: true })`: nested maps merge, everything else replaces. */
export function deepMerge(base: Record<string, any>, patch: Record<string, any>): Record<string, any> {
  const result: Record<string, any> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    result[key] = isPlainObject(value) && isPlainObject(result[key]) ? deepMerge(result[key], value) : value;
  }
  return result;
}

/** Firestore query semantics: a missing field never matches, comparisons need the same type. */
const SQL_FIELD = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const sqlScalar = (value: unknown): value is string | number => typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));

/** A filter SQLite can evaluate with the same result, or null. A missing field is NULL and never equal. */
function sqlFilter(filter: Filter): { sql: string; params: unknown[] } | null {
  if (!SQL_FIELD.test(filter.field)) return null;
  const field = `json_extract(data, '$.${filter.field}')`;
  if (filter.op === '==' && sqlScalar(filter.value)) return { sql: `${field} = ?`, params: [filter.value] };
  if (filter.op === 'in' && Array.isArray(filter.value) && filter.value.length > 0 && filter.value.length <= 30 && filter.value.every(sqlScalar)) {
    return { sql: `${field} IN (${filter.value.map(() => '?').join(', ')})`, params: filter.value };
  }
  return null;
}

export function matchesFilter(doc: Record<string, unknown>, filter: Filter): boolean {
  if (!Object.hasOwn(doc, filter.field)) return false;
  const value = doc[filter.field];
  const comparable = (typeof value === 'number' && typeof filter.value === 'number') || (typeof value === 'string' && typeof filter.value === 'string');
  switch (filter.op) {
    case '==': return deepEqual(value, filter.value);
    case '!=': return value !== null && !deepEqual(value, filter.value);
    case 'in': return Array.isArray(filter.value) && filter.value.some(item => deepEqual(item, value));
    case '<': return comparable && (value as any) < (filter.value as any);
    case '<=': return comparable && (value as any) <= (filter.value as any);
    case '>': return comparable && (value as any) > (filter.value as any);
    case '>=': return comparable && (value as any) >= (filter.value as any);
  }
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && deepEqual(a[key], b[key]));
  }
  return false;
}

/**
 * The document's TTL: a top-level `delete_at` (epoch milliseconds, an ISO
 * date or a Date), as a Firestore TTL policy field. The object that holds the
 * document deletes it once that time has passed (see ObjectScheduler); until
 * then readers still see it, so callers keep checking their own expiry.
 */
export const TTL_FIELD = 'delete_at';
export function expiryOf(data: Record<string, unknown>): number | null {
  const value = data[TTL_FIELD] as unknown;
  const time = typeof value === 'number' ? value : value instanceof Date ? value.valueOf() : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(time) ? Math.floor(time) : null;
}

type Row = { path: string; id: string; data: string; revision: number };
const toDoc = (row: Row): StoredDoc => ({ path: row.path, id: row.id, data: JSON.parse(row.data), revision: row.revision });

export class SqlDocumentEngine {
  constructor(private readonly sql: SqlDriver) {
    for (const statement of SCHEMA) this.sql.exec(statement);
    // Added after the first schema; databases created before it gain the column here.
    if (!this.sql.exec<{ name: string }>('PRAGMA table_info(documents)').some(column => column.name === 'delete_at')) {
      this.sql.exec('ALTER TABLE documents ADD COLUMN delete_at INTEGER');
    }
    this.sql.exec('CREATE INDEX IF NOT EXISTS documents_delete_at ON documents(delete_at) WHERE delete_at IS NOT NULL');
  }

  sequence(): number {
    return this.sql.exec<{ value: number }>("SELECT value FROM meta WHERE key = 'seq'")[0]?.value ?? 0;
  }

  get(path: string): StoredDoc | null {
    assertDocPath(path);
    const row = this.sql.exec<Row>('SELECT path, id, data, revision FROM documents WHERE path = ?', path)[0];
    return row ? toDoc(row) : null;
  }

  getMany(paths: string[]): Array<StoredDoc | null> {
    return paths.map(path => this.get(path));
  }

  /** Documents of one collection in id order; filters use Firestore semantics. */
  list(collection: string, options?: { filters?: Filter[]; limit?: number; startAfterId?: string } | null): StoredDoc[] {
    assertCollectionPath(collection);
    const opts = options ?? {};
    // Equality and `in` filters on plain top-level fields narrow the scan in
    // SQL; every filter is still checked on the parsed document. When all of
    // them were pushed down, the limit applies in SQL too.
    const where = ['parent = ?'], params: unknown[] = [collection];
    if (opts.startAfterId) { where.push('id > ?'); params.push(opts.startAfterId); }
    let exact = true;
    for (const filter of opts.filters ?? []) {
      const pushed = sqlFilter(filter);
      if (!pushed) { exact = false; continue; }
      where.push(pushed.sql);
      params.push(...pushed.params);
    }
    const limit = exact && opts.limit ? ` LIMIT ${Math.max(1, Math.floor(opts.limit))}` : '';
    const rows = this.sql.exec<Row>(`SELECT path, id, data, revision FROM documents WHERE ${where.join(' AND ')} ORDER BY id${limit}`, ...params);
    const result: StoredDoc[] = [];
    for (const row of rows) {
      const doc = toDoc(row);
      if ((opts.filters ?? []).every(filter => matchesFilter(doc.data, filter))) result.push(doc);
      if (opts.limit && result.length >= opts.limit) break;
    }
    return result;
  }

  /** All preconditions hold and all writes apply in one transaction, or nothing changes. */
  commit(preconditions: Precondition[], writes: Write[]): CommitResult {
    for (const item of [...preconditions, ...writes]) assertDocPath(item.path);
    return this.sql.transaction(() => {
      for (const condition of preconditions) {
        const current = this.sql.exec<{ revision: number }>('SELECT revision FROM documents WHERE path = ?', condition.path)[0]?.revision ?? null;
        if (current !== condition.revision) return { ok: false as const, conflict: condition.path };
      }
      const seq = this.sequence() + 1;
      this.sql.exec("INSERT INTO meta (key, value) VALUES ('seq', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", seq);
      for (const write of writes) this.apply(write, seq);
      return { ok: true as const, seq };
    });
  }

  private apply(write: Write, seq: number) {
    const row = this.sql.exec<Row>('SELECT path, id, data, revision FROM documents WHERE path = ?', write.path)[0];
    if (write.op === 'delete') {
      if (!row) return;
      this.sql.exec('DELETE FROM documents WHERE path = ?', write.path);
      this.sql.exec('INSERT INTO deletions (path, seq) VALUES (?, ?) ON CONFLICT(path) DO UPDATE SET seq = excluded.seq', write.path, seq);
      return;
    }
    const { id: _id, ...incoming } = clean(write.data) as Record<string, any>;
    void _id;
    const data = write.op === 'merge' && row ? deepMerge(JSON.parse(row.data), incoming) : incoming;
    this.sql.exec(`INSERT INTO documents (path, parent, id, data, revision, seq, delete_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET data = excluded.data, revision = excluded.revision, seq = excluded.seq, delete_at = excluded.delete_at`,
    write.path, parentOf(write.path), idOf(write.path), JSON.stringify(data), (row?.revision ?? 0) + 1, seq, expiryOf(data));
    this.sql.exec('DELETE FROM deletions WHERE path = ?', write.path);
  }

  /** Delete a document and everything beneath it. */
  deleteTree(path: string): number {
    assertDocPath(path);
    return this.sql.transaction(() => {
      const paths = this.sql.exec<{ path: string }>("SELECT path FROM documents WHERE path = ? OR substr(path, 1, ?) = ?", path, path.length + 1, `${path}/`).map(row => row.path);
      if (!paths.length) return 0;
      const seq = this.sequence() + 1;
      this.sql.exec("INSERT INTO meta (key, value) VALUES ('seq', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", seq);
      for (const item of paths) this.apply({ path: item, op: 'delete' }, seq);
      return paths.length;
    });
  }

  /** Earliest `delete_at` of any document, or null. */
  nextExpiry(): number | null {
    return this.sql.exec<{ t: number | null }>('SELECT MIN(delete_at) AS t FROM documents WHERE delete_at IS NOT NULL')[0]?.t ?? null;
  }

  /**
   * Delete up to `limit` documents whose `delete_at` has passed (the TTL).
   * No tombstone is kept: an expired document counts as already gone, and a
   * writer that still holds its revision conflicts and re-reads.
   */
  removeExpired(now: number, limit = 500): number {
    return this.sql.transaction(() => {
      const expired = this.sql.exec<{ path: string }>('SELECT path FROM documents WHERE delete_at IS NOT NULL AND delete_at <= ? ORDER BY delete_at LIMIT ?',
        now, Math.max(1, Math.floor(limit))).map(row => row.path);
      for (const path of expired) this.sql.exec('DELETE FROM documents WHERE path = ?', path);
      return expired.length;
    });
  }

  /** Whether any document under `root` changed or disappeared after `seq`. */
  changedSince(seq: number, root: string): boolean {
    const prefix = `${root}/`;
    const changed = this.sql.exec("SELECT 1 FROM documents WHERE seq > ? AND (path = ? OR substr(path, 1, ?) = ?) LIMIT 1", seq, root, prefix.length, prefix);
    if (changed.length) return true;
    return this.sql.exec("SELECT 1 FROM deletions WHERE seq > ? AND (path = ? OR substr(path, 1, ?) = ?) LIMIT 1", seq, root, prefix.length, prefix).length > 0;
  }

  /** Every document under a prefix, for exports and site transfers. */
  /** Every document path in path order after `after` (whole-object backup). */
  paths(after = '', limit = 1000): string[] {
    const bounded = Math.max(1, Math.min(5000, Math.floor(limit)));
    return this.sql.exec<{ path: string }>('SELECT path FROM documents WHERE path > ? ORDER BY path LIMIT ?', after, bounded).map(row => row.path);
  }

  exportTree(root: string, afterPath = '', limit = 500): StoredDoc[] {
    const prefix = `${root}/`;
    return this.sql.exec<Row>("SELECT path, id, data, revision FROM documents WHERE (path = ? OR substr(path, 1, ?) = ?) AND path > ? ORDER BY path LIMIT ?",
      root, prefix.length, prefix, afterPath, limit).map(toDoc);
  }
}
