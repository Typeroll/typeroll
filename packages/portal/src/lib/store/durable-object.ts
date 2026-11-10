// The SQL document engine inside a Cloudflare Durable Object.
//
// One object owns one SQLite database. Its methods are the engine's, exposed
// over Workers RPC; the caller wraps the stub with `durableObjectTransport` and
// uses `SqlStore` as an ordinary ReadWriteStore. Every method runs to
// completion without awaiting I/O, so the object's input gate keeps a commit's
// preconditions and writes atomic with respect to other requests.

import { SqlDocumentEngine, type CommitResult, type Filter, type Precondition, type StoredDoc, type SqlDriver, type Write } from './sql-engine';
import type { StoreTransport } from './sql-store';

/** The parts of DurableObjectStorage the engine uses (declared here to keep this module runtime-neutral). */
export interface DurableSqlStorage {
  sql: { exec(query: string, ...bindings: unknown[]): { toArray(): unknown[] } };
  transactionSync<T>(closure: () => T): T;
}

export function durableObjectDriver(storage: DurableSqlStorage): SqlDriver {
  return {
    exec: <T>(sql: string, ...params: unknown[]) => storage.sql.exec(sql, ...params).toArray() as T[],
    transaction: work => storage.transactionSync(work),
  };
}

/** The RPC surface of a document store object. */
export interface DocumentStoreRpc {
  get(path: string): StoredDoc | null;
  getMany(paths: string[]): Array<StoredDoc | null>;
  list(collection: string, opts?: { filters?: Filter[]; limit?: number; startAfterId?: string }): StoredDoc[];
  commit(preconditions: Precondition[], writes: Write[]): CommitResult;
  deleteTree(path: string): number;
  sequence(): number;
  changedSince(seq: number, root: string): boolean;
  exportTree(root: string, afterPath?: string, limit?: number): StoredDoc[];
  paths(after?: string, limit?: number): string[];
}

/** Housekeeping the object runs on itself; not part of the RPC surface. */
export interface DocumentStoreHousekeeping {
  nextExpiry(): number | null;
  removeExpired(now: number, limit?: number): number;
}

/** Engine methods bound for an object class: `Object.assign(this, documentStoreMethods(ctx.storage))`. */
export function documentStoreMethods(storage: DurableSqlStorage): DocumentStoreRpc & DocumentStoreHousekeeping {
  const engine = new SqlDocumentEngine(durableObjectDriver(storage));
  return {
    get: path => engine.get(path),
    getMany: paths => engine.getMany(paths),
    list: (collection, opts) => engine.list(collection, opts),
    commit: (preconditions, writes) => engine.commit(preconditions, writes),
    deleteTree: path => engine.deleteTree(path),
    sequence: () => engine.sequence(),
    changedSince: (seq, root) => engine.changedSince(seq, root),
    exportTree: (root, afterPath, limit) => engine.exportTree(root, afterPath, limit),
    paths: (after, limit) => engine.paths(after, limit),
    nextExpiry: () => engine.nextExpiry(),
    removeExpired: (now, limit) => engine.removeExpired(now, limit),
  };
}

/** A stub (Workers RPC, or any object with the same async methods) as a store transport. */
export function durableObjectTransport(stub: { [K in keyof DocumentStoreRpc]: (...args: Parameters<DocumentStoreRpc[K]>) => Promise<ReturnType<DocumentStoreRpc[K]>> | ReturnType<DocumentStoreRpc[K]> }): StoreTransport {
  return {
    get: async path => stub.get(path),
    getMany: async paths => stub.getMany(paths),
    list: async (collection, opts) => stub.list(collection, opts),
    commit: async (preconditions, writes) => stub.commit(preconditions, writes),
    deleteTree: async path => stub.deleteTree(path),
    sequence: async () => stub.sequence(),
    changedSince: async (seq, root) => stub.changedSince(seq, root),
    paths: async (after, limit) => stub.paths(after, limit),
  };
}
