// Tree-walk export of a whole document store as canonical NDJSON (format.ts).
//
// `ReadWriteStore` can list a collection but not discover collections, so each
// backend gets its own enumeration:
// - Firestore: `listCollections()` on the database and on every document
//   (including missing parents, whose subcollections survive a delete), then
//   `getAll()` for the raw stored data in batches. Data is read below the
//   portal codec, so block trees stay gzip-wrapped and secrets stay encrypted.
// - SQL objects (local SQLite files, or Durable Objects through a paging RPC):
//   every object's paths, merged into one canonical order, then read back.

import { shardFor } from '../store/sharded-store';
import { comparePaths, encodeStoredValue, ManifestBuilder, recordLine, type ExportManifest, type ExportRecord } from './format';

export interface ExportSource {
  /** Shown in the manifest, e.g. `firestore:typeroll-prod`. */
  label: string;
  /** Every document in `comparePaths` order, data as stored. */
  documents(types: Record<string, number>): AsyncIterable<ExportRecord>;
}

// ─── Firestore ────────────────────────────────────────────────────────────

/** The parts of the Firebase Admin Firestore API the walk uses. */
export interface FirestoreLike {
  listCollections(): Promise<FirestoreCollectionLike[]>;
  getAll(...refs: FirestoreDocRefLike[]): Promise<Array<{ exists: boolean; ref: { path: string }; data(): any }>>;
}
export interface FirestoreCollectionLike { id: string; listDocuments(): Promise<FirestoreDocRefLike[]> }
export interface FirestoreDocRefLike { id: string; path: string; listCollections(): Promise<FirestoreCollectionLike[]> }

const byId = <T extends { id: string }>(a: T, b: T) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

async function pool<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; results[i] = await work(items[i]!); }
  }));
  return results;
}

export function firestoreSource(db: FirestoreLike, opts: { label?: string; batch?: number; concurrency?: number } = {}): ExportSource {
  const batch = opts.batch ?? 300, concurrency = opts.concurrency ?? 16;
  async function* collection(ref: FirestoreCollectionLike, types: Record<string, number>): AsyncGenerator<ExportRecord> {
    const refs = (await ref.listDocuments()).sort(byId);
    for (let offset = 0; offset < refs.length; offset += batch) {
      const slice = refs.slice(offset, offset + batch);
      const [snapshots, children] = await Promise.all([
        db.getAll(...slice),
        pool(slice, concurrency, async doc => (await doc.listCollections()).sort(byId)),
      ]);
      const byPath = new Map(snapshots.map(snapshot => [snapshot.ref.path, snapshot]));
      for (let i = 0; i < slice.length; i++) {
        const doc = slice[i]!, snapshot = byPath.get(doc.path);
        if (snapshot?.exists) {
          let data: Record<string, unknown>;
          try { data = encodeStoredValue(snapshot.data(), types) as Record<string, unknown>; }
          catch (error) { throw new Error(`${doc.path}: ${(error as Error).message}`); }
          yield { path: doc.path, data };
        }
        for (const child of children[i]!) yield* collection(child, types);
      }
    }
  }
  return {
    label: opts.label ?? 'firestore',
    async *documents(types) {
      for (const root of (await db.listCollections()).sort(byId)) yield* collection(root, types);
    },
  };
}

/** A Firestore database from the Firebase Admin SDK, with the portal's credential variables. */
export async function openFirestore(env: Record<string, string | undefined> = process.env): Promise<{ db: FirestoreLike; projectId: string }> {
  // Resolved at run time so the store code does not depend on firebase-admin.
  const appModule = 'firebase-admin/app', firestoreModule = 'firebase-admin/firestore';
  const { initializeApp, applicationDefault, cert, getApps } = await import(/* @vite-ignore */ appModule);
  const { getFirestore } = await import(/* @vite-ignore */ firestoreModule);
  const raw = env.FIREBASE_SERVICE_ACCOUNT?.trim();
  const credentials = raw ? JSON.parse(raw) : null;
  const projectId = env.FIREBASE_PROJECT_ID?.trim() || credentials?.project_id;
  if (!projectId) throw new Error('Set FIREBASE_PROJECT_ID (Application Default Credentials) or FIREBASE_SERVICE_ACCOUNT');
  const app = getApps()[0] ?? initializeApp({ credential: credentials ? cert(credentials) : applicationDefault(), projectId });
  return { db: getFirestore(app) as FirestoreLike, projectId };
}

// ─── SQL objects ──────────────────────────────────────────────────────────

/**
 * One SQL document database. `kind` says which documents it owns in a
 * sharded installation; `single` is an unsharded store (`TYPEROLL_STORE=sqlite:`).
 */
export interface SqlExportObject {
  name: string;
  kind: 'single' | 'global' | 'org' | 'site';
  /** All document paths, any order. */
  paths(): AsyncIterable<string>;
  getMany(paths: string[]): Promise<Array<{ data: Record<string, any> } | null>>;
}

const isSiteDoc = (path: string) => /^organizations\/[^/]+\/sites\/[^/]+$/.test(path);

/** Whether a sharded object is the owner of a path (organization copies, outboxes and per-object indexes are not). */
export function ownsPath(kind: SqlExportObject['kind'], path: string): boolean {
  if (path.startsWith('_outbox/')) return false;
  if (kind === 'single') return true;
  const shard = shardFor(path).kind;
  if (kind === 'org') return shard === 'org' && !isSiteDoc(path);
  return shard === kind;
}

export function sqlSource(objects: SqlExportObject[], opts: { label?: string; batch?: number; skipped?: Record<string, number> } = {}): ExportSource {
  const batch = opts.batch ?? 200;
  return {
    label: opts.label ?? 'sql',
    async *documents() {
      const owner = new Map<string, SqlExportObject>();
      for (const object of objects) {
        for await (const path of object.paths()) {
          if (!ownsPath(object.kind, path)) { if (opts.skipped) opts.skipped[object.name] = (opts.skipped[object.name] ?? 0) + 1; continue; }
          if (owner.has(path)) throw new Error(`${path} is owned by both ${owner.get(path)!.name} and ${object.name}`);
          owner.set(path, object);
        }
      }
      const paths = [...owner.keys()].sort(comparePaths);
      for (let offset = 0; offset < paths.length; offset += batch) {
        const slice = paths.slice(offset, offset + batch);
        // Read each object's part of the slice in one call.
        const groups = new Map<SqlExportObject, string[]>();
        for (const path of slice) { const object = owner.get(path)!; groups.set(object, [...groups.get(object) ?? [], path]); }
        const data = new Map<string, Record<string, any>>();
        for (const [object, group] of groups) {
          const docs = await object.getMany(group);
          group.forEach((path, i) => { if (docs[i]) data.set(path, docs[i]!.data); });
        }
        for (const path of slice) if (data.has(path)) yield { path, data: data.get(path)! };
      }
    },
  };
}

// ─── Writing ──────────────────────────────────────────────────────────────

/** Stream every record through `write` (one line, no newline) and return the manifest. */
export async function exportStore(source: ExportSource, write: (line: string) => void | Promise<void>, opts: { createdAt?: string } = {}): Promise<ExportManifest> {
  const builder = new ManifestBuilder();
  const types: Record<string, number> = {};
  for await (const record of source.documents(types)) {
    const line = recordLine(record);
    builder.add(record.path, line);
    await write(line);
  }
  return builder.finish({ source: source.label, createdAt: opts.createdAt ?? new Date().toISOString(), firestoreTypes: types });
}
