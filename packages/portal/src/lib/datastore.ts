// Server-side read+write datastore for the portal.
//
// Same two-backend pattern as the site renderer (Firestore for prod,
// JSON-on-disk for local dev), extended with write operations.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getFirebaseAdminApp, isFirebaseAdminConfigured } from './firebase-admin';
import { encodeNestedArrays, decodeNestedArrays } from './firestore-codec';

export interface Filter {
  field: string;
  op: '==' | '!=' | '<' | '<=' | '>' | '>=' | 'in';
  value: unknown;
}

export interface ReadWriteStore {
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
  listDocs<T = unknown>(
    collectionPath: string,
    opts?: { filters?: Filter[]; limit?: number }
  ): Promise<Array<T & { id: string }>>;
  addDoc(collectionPath: string, data: Record<string, any>): Promise<string>;
  /**
   * Atomically update a document only when the current value passes `check`.
   * Returns the value that won the check, or null when absent/rejected. Used
   * for single-use grants and rotation races; ordinary updates should keep
   * using updateDoc.
   */
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

  async getDoc<T>(p: string): Promise<(T & { id: string }) | null> {
    const { docPath } = this.resolve(p);
    if (!fs.existsSync(docPath)) return null;
    const raw = await fs.promises.readFile(docPath, 'utf-8');
    const id = path.basename(p);
    return { id, ...(JSON.parse(raw) as T) };
  }

  async setDoc(p: string, data: Record<string, any>): Promise<void> {
    return this.withLock(p, async () => {
      const { docPath } = this.resolve(p);
      await fs.promises.mkdir(path.dirname(docPath), { recursive: true });
      // Atomic write: temp file + rename. A crash mid-write leaves either the
      // old file or no file, never a truncated half-written .json.
      const tmpPath = `${docPath}.${process.pid}.${Date.now()}.tmp`;
      const { id: _id, ...rest } = data;
      void _id;
      await fs.promises.writeFile(tmpPath, JSON.stringify(rest, null, 2));
      await fs.promises.rename(tmpPath, docPath);
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
    });
  }

  async deleteDoc(p: string): Promise<void> {
    const { docPath } = this.resolve(p);
    if (fs.existsSync(docPath)) await fs.promises.unlink(docPath);
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
    opts: { filters?: Filter[]; limit?: number } = {}
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
    if (opts.limit) results = results.slice(0, opts.limit);
    return results;
  }

  async addDoc(p: string, data: Record<string, any>): Promise<string> {
    const id = generateId();
    await this.setDoc(`${p}/${id}`, data);
    return id;
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

// ─── Firestore (read+write) ──────────────────────────────────────────────

class FirestoreStore implements ReadWriteStore {
  private dbPromise: Promise<import('firebase-admin/firestore').Firestore>;

  constructor() {
    this.dbPromise = (async () => {
      const { getFirestore } = await import('firebase-admin/firestore');
      const app = await getFirebaseAdminApp();
      const db = getFirestore(app);
      // Our doc shapes have lots of optional fields that arrive as
      // `undefined` from the route handlers. Firestore rejects those by
      // default; this setting tells it to drop the keys instead. Matches
      // the fixtures backend's tolerance.
      db.settings({ ignoreUndefinedProperties: true });
      return db;
    })();
  }

  async getDoc<T>(p: string): Promise<(T & { id: string }) | null> {
    const db = await this.dbPromise;
    const snap = await db.doc(p).get();
    if (!snap.exists) return null;
    return { id: snap.id, ...decodeNestedArrays(snap.data() as T) };
  }

  async setDoc(p: string, data: Record<string, any>): Promise<void> {
    const db = await this.dbPromise;
    // Firestore rejects directly-nested arrays (Block.slots is Block[][]) —
    // the codec wraps inner arrays in marker maps on write and unwraps on
    // read, so callers see the same shape the fixtures backend stores.
    await db.doc(p).set(encodeNestedArrays(data));
  }

  async createDocIfMissing(p: string, data: Record<string, any>): Promise<boolean> {
    const db = await this.dbPromise;
    return db.runTransaction(async (transaction) => {
      const ref = db.doc(p);
      const snap = await transaction.get(ref);
      if (snap.exists) return false;
      transaction.create(ref, encodeNestedArrays(data));
      return true;
    });
  }

  async updateDoc(p: string, data: Record<string, any>): Promise<void> {
    const db = await this.dbPromise;
    await db.doc(p).set(encodeNestedArrays(data), { merge: true });
  }

  async deleteDoc(p: string): Promise<void> {
    const db = await this.dbPromise;
    await db.doc(p).delete();
  }

  async deleteTree(p: string): Promise<void> {
    const db = await this.dbPromise;
    const docRef = db.doc(p);
    // Recursively walk every subcollection and delete each doc, then drop the
    // root doc. Done in batches because firestore doesn't ship a recursive
    // delete in the regular SDK — the admin SDK does (`firestore.recursiveDelete`)
    // but only for paths it owns; this works for both subtree shapes.
    const walk = async (ref: FirebaseFirestore.DocumentReference): Promise<void> => {
      const subs = await ref.listCollections();
      for (const sub of subs) {
        const snap = await sub.get();
        for (const d of snap.docs) await walk(d.ref);
      }
      await ref.delete();
    };
    await walk(docRef);
  }

  async listDocs<T>(
    p: string,
    opts: { filters?: Filter[]; limit?: number } = {}
  ): Promise<Array<T & { id: string }>> {
    const db = await this.dbPromise;
    let q: FirebaseFirestore.Query = db.collection(p);
    for (const f of opts.filters ?? []) {
      q = q.where(f.field, f.op as FirebaseFirestore.WhereFilterOp, f.value);
    }
    if (opts.limit) q = q.limit(opts.limit);
    const snap = await q.get();
    return snap.docs.map((d) => ({ id: d.id, ...decodeNestedArrays(d.data() as T) }));
  }

  async addDoc(p: string, data: Record<string, any>): Promise<string> {
    const db = await this.dbPromise;
    const ref = await db.collection(p).add(encodeNestedArrays(data));
    return ref.id;
  }

  async compareAndUpdateDoc<T>(
    p: string,
    check: (current: T & { id: string }) => boolean,
    data: Record<string, any>,
  ): Promise<(T & { id: string }) | null> {
    const db = await this.dbPromise;
    return db.runTransaction(async (transaction) => {
      const ref = db.doc(p);
      const snap = await transaction.get(ref);
      if (!snap.exists) return null;
      const current = { id: snap.id, ...decodeNestedArrays(snap.data() as T) } as T & { id: string };
      if (!check(current)) return null;
      transaction.set(ref, encodeNestedArrays(data), { merge: true });
      return current;
    });
  }
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

export function getStore(): ReadWriteStore {
  if (cached) return cached;
  if (isFirebaseAdminConfigured()) {
    cached = new FirestoreStore();
  } else {
    const dir = process.env.TYPEROLL_FIXTURES_DIR || defaultFixturesDir();
    cached = new FixtureStore(dir);
  }
  return cached;
}

export function generateDocId(): string {
  return generateId();
}

/** Test-only: drop the cached singleton so the next getStore() call
 *  re-evaluates env vars. Production code should never call this. */
export function _resetForTests(): void {
  cached = null;
}
