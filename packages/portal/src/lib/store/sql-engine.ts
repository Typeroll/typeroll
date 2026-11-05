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

type Row = { path: string; id: string; data: string; revision: number };
const toDoc = (row: Row): StoredDoc => ({ path: row.path, id: row.id, data: JSON.parse(row.data), revision: row.revision });

export class SqlDocumentEngine {
  constructor(private readonly sql: SqlDriver) {
    for (const statement of SCHEMA) this.sql.exec(statement);
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
  list(collection: string, opts: { filters?: Filter[]; limit?: number; startAfterId?: string } = {}): StoredDoc[] {
    assertCollectionPath(collection);
    const rows = opts.startAfterId
      ? this.sql.exec<Row>('SELECT path, id, data, revision FROM documents WHERE parent = ? AND id > ? ORDER BY id', collection, opts.startAfterId)
      : this.sql.exec<Row>('SELECT path, id, data, revision FROM documents WHERE parent = ? ORDER BY id', collection);
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
    this.sql.exec(`INSERT INTO documents (path, parent, id, data, revision, seq) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET data = excluded.data, revision = excluded.revision, seq = excluded.seq`,
    write.path, parentOf(write.path), idOf(write.path), JSON.stringify(data), (row?.revision ?? 0) + 1, seq);
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

  /** Whether any document under `root` changed or disappeared after `seq`. */
  changedSince(seq: number, root: string): boolean {
    const prefix = `${root}/`;
    const changed = this.sql.exec("SELECT 1 FROM documents WHERE seq > ? AND (path = ? OR substr(path, 1, ?) = ?) LIMIT 1", seq, root, prefix.length, prefix);
    if (changed.length) return true;
    return this.sql.exec("SELECT 1 FROM deletions WHERE seq > ? AND (path = ? OR substr(path, 1, ?) = ?) LIMIT 1", seq, root, prefix.length, prefix).length > 0;
  }

  /** Every document under a prefix, for exports and site transfers. */
  exportTree(root: string, afterPath = '', limit = 500): StoredDoc[] {
    const prefix = `${root}/`;
    return this.sql.exec<Row>("SELECT path, id, data, revision FROM documents WHERE (path = ? OR substr(path, 1, ?) = ?) AND path > ? ORDER BY path LIMIT ?",
      root, prefix.length, prefix, afterPath, limit).map(toDoc);
  }
}
