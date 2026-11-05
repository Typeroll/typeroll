// Server-side read+write datastore for the portal.
//
// Deployed Workers register the Durable Object store (src/worker.ts →
// setRuntimeStore). Without one, Node processes (tests, scripts, local tools)
// use JSON-on-disk fixtures, or one local SQLite file with
// TYPEROLL_STORE=sqlite:<file>.

import fs from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { isDeepStrictEqual } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scheduledIndexWrites, notifyScheduledWrites } from './scheduling/index';
import { nodeSqliteDriver } from './store/node-sqlite';
import { SqlDocumentEngine } from './store/sql-engine';
import { SqlStore, localTransport } from './store/sql-store';

export interface Filter {
  field: string;
  op: '==' | '!=' | '<' | '<=' | '>' | '>=' | 'in';
  value: unknown;
}

export interface ConditionalEffect {
  path: string; data: Record<string, any>;
  /** When provided, all comparisons and writes participate in one transaction. */
  expected?: Record<string, any> | null;
  replace?: boolean;
  guardOnly?: boolean;
}

type SnapshotReader = Pick<ReadWriteStore, 'getDoc' | 'listDocs'>;
const readContext = new AsyncLocalStorage<ReadWriteStore>();
function inReadContext<T>(reader: SnapshotReader, work: () => Promise<T>): Promise<T> {
  const readOnly = new Proxy(reader, { get(target, key) {
    if (key === 'getDoc' || key === 'listDocs') return target[key].bind(target);
    return () => { throw new Error('Writes are not allowed while capturing publication content'); };
  } }) as ReadWriteStore;
  return readContext.run(readOnly, work);
}

/** Run `work` with reads routed to `reader` and every write refused. */
export function runReadOnly<T>(reader: SnapshotReader, work: () => Promise<T>): Promise<T> {
  return inReadContext(reader, work);
}

export interface ReadWriteStore {
  /** Coherent content reads; writes remain outside the snapshot. */
  readSnapshot?<T>(root: string, work: () => Promise<T>): Promise<T>;
  getDoc<T = unknown>(path: string): Promise<(T & { id: string }) | null>;
  setDoc(path: string, data: Record<string, any>): Promise<void>;
  /** Atomically create a document only when it does not already exist. */
  createDocIfMissing(path: string, data: Record<string, any>): Promise<boolean>;
  updateDoc(path: string, data: Record<string, any>): Promise<void>;
  deleteDoc(path: string): Promise<void>;
  /**
   * Delete a doc and every doc beneath it (its subcollections, their
   * subcollections, etc.). Used when removing a SiteVersion so its overrides,
   * tombstones, revisions, and chat history don't leak as orphans.
   */
  deleteTree(path: string): Promise<void>;
  /** startAfterId opts into document-ID ordering; an empty string starts the first page. */
  listDocs<T = unknown>(
    collectionPath: string,
    opts?: { filters?: Filter[]; limit?: number; startAfterId?: string }
  ): Promise<Array<T & { id: string }>>;
  addDoc(collectionPath: string, data: Record<string, any>): Promise<string>;
  /**
   * Atomically update a document only when the current value passes `check`.
   * Returns the value that won the check, or null when absent/rejected. Used
   * for single-use grants and rotation races; ordinary updates should keep
   * using updateDoc.
   */
  /** Compare the complete value returned by getDoc and replace without merging nested fields. */
  compareAndReplaceDoc(path: string, expected: Record<string, any> | null, data: Record<string, any>, effects?: ConditionalEffect[]): Promise<boolean>;
  compareAndUpdateDoc<T = unknown>(
    path: string,
    check: (current: T & { id: string }) => boolean,
    data: Record<string, any>,
  ): Promise<(T & { id: string }) | null>;
}

// ─── Fixtures (read+write) ───────────────────────────────────────────────

class FixtureStore implements ReadWriteStore {
  // Per-path write mutex. Without this, the page autosave + AI chat (which
  // both call setDoc/updateDoc against the same path) can interleave their
  // read-merge-write cycles and clobber each other.
  private locks = new Map<string, Promise<void>>();

  constructor(private root: string) {
    // Don't pre-create the dir here — the resolver's existence check uses
    // dir-non-empty as a signal of "this is the real fixtures dir". Mutation
    // methods create parent dirs lazily as needed.
  }

  async readSnapshot<T>(root: string, work: () => Promise<T>): Promise<T> {
    // Fixture writes use atomic rename. Capture synchronously so local async
    // writers cannot interleave pages and templates while building this view.
    const records = new Map<string, Record<string, any>>();
    const walk = (directory: string, prefix: string) => {
      if (!fs.existsSync(directory)) return;
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (entry.isDirectory()) walk(path.join(directory, entry.name), `${prefix}/${entry.name}`);
        else if (entry.isFile() && entry.name.endsWith('.json')) {
          const id = entry.name.slice(0, -5);
          records.set(`${prefix}/${id}`, { id, ...JSON.parse(fs.readFileSync(path.join(directory, entry.name), 'utf8')) });
        }
      }
    };
    walk(this.resolve(root).dirPath, root);
    const assertRoot = (p: string) => { if (p !== root && !p.startsWith(`${root}/`)) throw new Error('Read outside publication snapshot'); };
    return inReadContext({
      getDoc: async <D>(p: string) => { assertRoot(p); return structuredClone(records.get(p) ?? null) as (D & { id: string }) | null; },
      listDocs: async <D>(p: string, opts: { filters?: Filter[]; limit?: number; startAfterId?: string } = {}) => {
        assertRoot(p);
        let found = [...records].filter(([key]) => key.slice(0, key.lastIndexOf('/')) === p).map(([, value]) => value);
        found = found.filter(value => (opts.filters ?? []).every(filter => matchesFilter(value, filter)));
        if (opts.startAfterId !== undefined) found = found.sort((a, b) => a.id.localeCompare(b.id)).filter(value => value.id > opts.startAfterId!);
        if (opts.limit) found = found.slice(0, opts.limit);
        return structuredClone(found) as Array<D & { id: string }>;
      },
    }, work);
  }

  private async withLock<T>(p: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(p) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => (release = resolve));
    this.locks.set(p, prev.then(() => next));
    try {
      await prev;
      return await fn();
    } finally {
      release();
      if (this.locks.get(p) === prev.then(() => next)) this.locks.delete(p);
    }
  }

  private resolve(p: string): { dirPath: string; docPath: string } {
    // Resolve and confirm the result is still inside `root`. A naive
    // .replace('..','') misses encoded forms, nested `....//`, absolute paths
    // and so on; path.resolve + prefix check is the only reliable defense.
    const dirPath = path.resolve(this.root, p);
    const rootResolved = path.resolve(this.root);
    if (dirPath !== rootResolved && !dirPath.startsWith(rootResolved + path.sep)) {
      throw new Error(`Refusing to access path outside fixtures root: ${p}`);
    }
    return { dirPath, docPath: `${dirPath}.json` };
  }

  private async indexWrite(p: string, before: any, after: any) {
    const writes = scheduledIndexWrites(p, before, after);
    for (const write of writes) {
      if (write.data) await this.setDoc(write.path, write.data);
      else await this.deleteDoc(write.path);
    }
    await notifyScheduledWrites(writes);
  }

  async getDoc<T>(p: string): Promise<(T & { id: string }) | null> {
    const { docPath } = this.resolve(p);
    if (!fs.existsSync(docPath)) return null;
    const raw = await fs.promises.readFile(docPath, 'utf-8');
    const id = path.basename(p);
    return { id, ...(JSON.parse(raw) as T) };
  }

  async setDoc(p: string, data: Record<string, any>): Promise<void> {
    return this.withLock(p, async () => {
      const before = await this.getDoc(p);
      const { docPath } = this.resolve(p);
      await fs.promises.mkdir(path.dirname(docPath), { recursive: true });
      // Atomic write: temp file + rename. A crash mid-write leaves either the
      // old file or no file, never a truncated half-written .json.
      const tmpPath = `${docPath}.${process.pid}.${Date.now()}.tmp`;
      const { id: _id, ...rest } = data;
      void _id;
      await fs.promises.writeFile(tmpPath, JSON.stringify(rest, null, 2));
      await fs.promises.rename(tmpPath, docPath);
      await this.indexWrite(p, before, rest);
    });
  }

  async createDocIfMissing(p: string, data: Record<string, any>): Promise<boolean> {
    return this.withLock(p, async () => {
      const { docPath } = this.resolve(p);
      if (fs.existsSync(docPath)) return false;
      await fs.promises.mkdir(path.dirname(docPath), { recursive: true });
      const tmpPath = `${docPath}.${process.pid}.${Date.now()}.tmp`;
      const { id: _id, ...rest } = data;
      void _id;
      await fs.promises.writeFile(tmpPath, JSON.stringify(rest, null, 2));
      await fs.promises.rename(tmpPath, docPath);
      await this.indexWrite(p, null, rest);
      return true;
    });
  }

  async updateDoc(p: string, data: Record<string, any>): Promise<void> {
    return this.withLock(p, async () => {
      const existing = (await this.getDoc<Record<string, any>>(p)) ?? {};
      const { id: _ignored, ...rest } = existing as Record<string, any>;
      void _ignored;
      const { docPath } = this.resolve(p);
      await fs.promises.mkdir(path.dirname(docPath), { recursive: true });
      const tmpPath = `${docPath}.${process.pid}.${Date.now()}.tmp`;
      const merged = { ...rest, ...data };
      const { id: _outId, ...toWrite } = merged;
      void _outId;
      await fs.promises.writeFile(tmpPath, JSON.stringify(toWrite, null, 2));
      await fs.promises.rename(tmpPath, docPath);
      await this.indexWrite(p, existing, toWrite);
    });
  }

  async deleteDoc(p: string): Promise<void> {
    const { docPath } = this.resolve(p);
    const before = await this.getDoc(p);
    if (fs.existsSync(docPath)) await fs.promises.unlink(docPath);
    await this.indexWrite(p, before, null);
  }

  async deleteTree(p: string): Promise<void> {
    const { dirPath, docPath } = this.resolve(p);
    // Remove the doc file (if any) and the sibling directory holding the
    // subcollections. Both can coexist (a doc and its subcollections live
    // side by side in this layout).
    if (fs.existsSync(docPath)) await fs.promises.unlink(docPath);
    if (fs.existsSync(dirPath)) await fs.promises.rm(dirPath, { recursive: true, force: true });
  }

  async listDocs<T>(
    p: string,
    opts: { filters?: Filter[]; limit?: number; startAfterId?: string } = {}
  ): Promise<Array<T & { id: string }>> {
    const { dirPath } = this.resolve(p);
    if (!fs.existsSync(dirPath)) return [];
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    let results: Array<T & { id: string }> = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const id = entry.name.replace(/\.json$/, '');
      const raw = await fs.promises.readFile(path.join(dirPath, entry.name), 'utf-8');
      results.push({ id, ...(JSON.parse(raw) as T) });
    }
    if (opts.filters?.length) {
      results = results.filter((doc) =>
        opts.filters!.every((f) => matchesFilter(doc as Record<string, unknown>, f))
      );
    }
    if (opts.startAfterId !== undefined) {
      results.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      results = results.filter(doc => doc.id > opts.startAfterId!);
    }
    if (opts.limit) results = results.slice(0, opts.limit);
    return results;
  }

  async addDoc(p: string, data: Record<string, any>): Promise<string> {
    const id = generateId();
    await this.setDoc(`${p}/${id}`, data);
    return id;
  }

  async compareAndReplaceDoc(p: string, expected: Record<string, any> | null, data: Record<string, any>, effects: ConditionalEffect[] = []): Promise<boolean> {
    const keys = [...new Set([p, ...effects.map(effect => effect.path)])].sort();
    const locked = async (index: number): Promise<boolean> => index < keys.length
      ? this.withLock(keys[index], () => locked(index + 1)) : commit();
    const commit = async () => {
      if (!isDeepStrictEqual(await this.getDoc(p), expected)) return false;
      const before = await Promise.all(effects.map(effect => this.getDoc(effect.path)));
      if (effects.some((effect, i) => Object.hasOwn(effect, 'expected') && !isDeepStrictEqual(before[i], effect.expected))) return false;
      const writes = [{ path: p, data, before: expected }, ...effects.map((effect, i) => ({ ...effect, path: effect.path,
        data: effect.replace ? effect.data : { ...before[i], ...effect.data }, before: before[i] })).filter(effect => !effect.guardOnly)];
      for (const write of writes) {
        const { docPath } = this.resolve(write.path);
        await fs.promises.mkdir(path.dirname(docPath), { recursive: true });
        const tmpPath = `${docPath}.${process.pid}.${Date.now()}.tmp`;
        await fs.promises.writeFile(tmpPath, JSON.stringify(write.data, null, 2));
        await fs.promises.rename(tmpPath, docPath);
      }
      for (const write of writes) await this.indexWrite(write.path, write.before, write.data);
      return true;
    };
    return locked(0);
  }

  async compareAndUpdateDoc<T>(
    p: string,
    check: (current: T & { id: string }) => boolean,
    data: Record<string, any>,
  ): Promise<(T & { id: string }) | null> {
    return this.withLock(p, async () => {
      const current = await this.getDoc<T>(p);
      if (!current || !check(current)) return null;
      const { id: _id, ...existing } = current as Record<string, any>;
      void _id;
      const { docPath } = this.resolve(p);
      await fs.promises.mkdir(path.dirname(docPath), { recursive: true });
      const tmpPath = `${docPath}.${process.pid}.${Date.now()}.tmp`;
      await fs.promises.writeFile(tmpPath, JSON.stringify({ ...existing, ...data }, null, 2));
      await fs.promises.rename(tmpPath, docPath);
      await this.indexWrite(p, current, { ...existing, ...data });
      return current;
    });
  }
}

function matchesFilter(doc: Record<string, unknown>, f: Filter): boolean {
  const v = doc[f.field];
  switch (f.op) {
    case '==':
      return v === f.value;
    case '!=':
      return v !== f.value;
    case '<':
      return (v as number) < (f.value as number);
    case '<=':
      return (v as number) <= (f.value as number);
    case '>':
      return (v as number) > (f.value as number);
    case '>=':
      return (v as number) >= (f.value as number);
    case 'in':
      return Array.isArray(f.value) && (f.value as unknown[]).includes(v);
  }
}

function generateId(): string {
  // Compact, sortable-ish id. Not cryptographic.
  return (
    Date.now().toString(36) +
    Math.random().toString(36).slice(2, 8)
  );
}

// ─── Factory ─────────────────────────────────────────────────────────────

function defaultFixturesDir(): string {
  // Find the canonical fixtures dir by looking for one that contains the
  // expected `organizations/` subtree. Otherwise fall back to cwd/fixtures.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, '..', '..', '..', 'site-template', 'fixtures'),
    path.resolve(here, '..', '..', '..', '..', 'site-template', 'fixtures'),
    path.resolve(here, '..', '..', '..', '..', '..', 'site-template', 'fixtures'),
    path.resolve(process.cwd(), '..', 'site-template', 'fixtures'),
    path.resolve(process.cwd(), 'packages', 'site-template', 'fixtures'),
    path.resolve(process.cwd(), 'fixtures'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'organizations'))) return c;
  }
  return path.resolve(process.cwd(), 'fixtures');
}

let cached: ReadWriteStore | null = null;
let runtimeStore: (() => ReadWriteStore) | null = null;

/** The Worker entry registers the Durable Object store before serving requests. */
export function setRuntimeStore(factory: (() => ReadWriteStore) | null): void {
  runtimeStore = factory;
  cached = null;
}

export function getStore(): ReadWriteStore {
  const snapshot = readContext.getStore();
  if (snapshot) return snapshot;
  if (cached) return cached;
  if (runtimeStore) return (cached = runtimeStore());
  const sqlite = process.env.TYPEROLL_STORE?.match(/^sqlite:(.+)$/)?.[1];
  if (sqlite) {
    cached = createSqliteStore(sqlite);
  } else {
    const dir = process.env.TYPEROLL_FIXTURES_DIR || defaultFixturesDir();
    cached = new FixtureStore(dir);
  }
  return cached;
}

export type StoreBackend = 'durable_object' | 'sqlite' | 'fixtures';

/**
 * Which backend `getStore()` serves. Only the Durable Object store is a
 * deployment backend; fixtures and a local SQLite file are versioned with the
 * source or belong to one developer's machine.
 */
export function storeBackend(env: Record<string, string | undefined> = process.env): StoreBackend {
  if (runtimeStore) return 'durable_object';
  return /^sqlite:./.test(env.TYPEROLL_STORE ?? '') ? 'sqlite' : 'fixtures';
}

/** The SQL document store on a local SQLite file (`TYPEROLL_STORE=sqlite:<file>`). */
function createSqliteStore(file: string): ReadWriteStore {
  return new SqlStore(localTransport(new SqlDocumentEngine(nodeSqliteDriver(file))), generateId);
}

export function generateDocId(): string {
  return generateId();
}

/** Test-only: drop the cached singleton so the next getStore() call
 *  re-evaluates env vars. Production code should never call this. */
export function _resetForTests(): void {
  cached = null;
}
