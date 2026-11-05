// ReadWriteStore on the revision-based SQL engine.
//
// The engine may live in another process (a Durable Object reached over RPC),
// so every method here is optimistic: read documents with their revisions,
// decide in this process, then commit on the condition that nothing it read
// has changed. A conflict means another writer won; the operation re-reads and
// decides again, as a Firestore transaction would retry.

import { runReadOnly, type ConditionalEffect, type ReadWriteStore } from '../datastore';
import { notifyScheduledWrites, scheduledIndexWrites, type IndexWrite } from '../scheduling/index';
import { deepEqual, deepMerge, clean, type CommitResult, type Filter, type Precondition, type StoredDoc, type Write } from './sql-engine';
import { StorageDocumentError } from '../firestore-codec';

/** The engine's operations as seen from the caller; in-process or a Durable Object stub. */
export interface StoreTransport {
  get(path: string): Promise<StoredDoc | null>;
  getMany(paths: string[]): Promise<Array<StoredDoc | null>>;
  list(collection: string, opts?: { filters?: Filter[]; limit?: number; startAfterId?: string }): Promise<StoredDoc[]>;
  commit(preconditions: Precondition[], writes: Write[]): Promise<CommitResult>;
  deleteTree(path: string): Promise<number>;
  sequence(): Promise<number>;
  changedSince(seq: number, root: string): Promise<boolean>;
}

/** Conflicts beyond this are a hot document, not ordinary contention. */
const MAX_ATTEMPTS = 25;
const SNAPSHOT_ATTEMPTS = 5;

const asValue = (doc: StoredDoc | null) => doc ? { id: doc.id, ...doc.data } : null;
const condition = (path: string, doc: StoredDoc | null): Precondition => ({ path, revision: doc?.revision ?? null });

class ConflictError extends Error {
  constructor(path: string) { super(`Too many concurrent updates to ${path}; retry this operation`); this.name = 'StoreConflictError'; }
}

export class SqlStore implements ReadWriteStore {
  constructor(private readonly transport: StoreTransport, private readonly newId: () => string) {}

  /** Index writes for the scheduled-work outbox, committed with their source. */
  private indexFor(path: string, before: any, after: any): { writes: Write[]; index: IndexWrite[] } {
    const index = scheduledIndexWrites(path, before, after);
    return { index, writes: index.map(item => item.data ? { path: item.path, op: 'set' as const, data: item.data } : { path: item.path, op: 'delete' as const }) };
  }

  /** Read, decide, commit; repeat on conflict. `decide` returns null to commit nothing. */
  private async optimistic<T>(paths: string[], decide: (docs: Array<StoredDoc | null>) => { writes: Write[]; index: IndexWrite[]; result: T } | { result: T; writes?: undefined }): Promise<T> {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const docs = await this.transport.getMany(paths);
      let decision: ReturnType<typeof decide>;
      try { decision = decide(docs); }
      catch (error) {
        // Circular input overflows the recursive clean-up before validation can name it.
        if (error instanceof RangeError) throw new StorageDocumentError('storage_document_invalid', 'The document contains circular or invalid data. No content was saved.', paths[0]);
        throw error;
      }
      if (!decision.writes) return decision.result;
      for (const write of decision.writes) if (write.op !== 'delete') assertStorableDocument(write.path, write.data);
      const committed = await this.transport.commit(paths.map((path, i) => condition(path, docs[i])), decision.writes);
      if (committed.ok) {
        if (decision.index.length) await notifyScheduledWrites(decision.index);
        return decision.result;
      }
    }
    throw new ConflictError(paths[0]!);
  }

  /**
   * Replace one document with what `decide` returns from its current value (null deletes it),
   * committing `extra` documents in the same transaction. `skip` commits nothing.
   */
  async mutate<T>(path: string, decide: (before: (Record<string, any> & { id: string }) | null) => { after: Record<string, any> | null; result: T } | { skip: true; result: T },
    extra: (after: Record<string, any> | null) => Array<{ path: string; data: Record<string, any> }> = () => []): Promise<T> {
    return this.optimistic([path], ([before]) => {
      const decision = decide(asValue(before) as (Record<string, any> & { id: string }) | null);
      if ('skip' in decision) return { result: decision.result };
      const after = decision.after === null ? null : (({ id: _id, ...rest }) => rest)(clean(decision.after) as Record<string, any>);
      const { writes, index } = this.indexFor(path, before?.data ?? null, after);
      const own: Write = after === null ? { path, op: 'delete' } : { path, op: 'set', data: after };
      return { writes: [own, ...writes, ...extra(after).map(item => ({ path: item.path, op: 'set' as const, data: item.data }))], index, result: decision.result };
    });
  }

  async getDoc<T = unknown>(path: string): Promise<(T & { id: string }) | null> {
    return asValue(await this.transport.get(path)) as (T & { id: string }) | null;
  }

  async setDoc(path: string, data: Record<string, any>): Promise<void> {
    await this.optimistic([path], ([before]) => {
      const after = clean(data);
      const { writes, index } = this.indexFor(path, before?.data ?? null, after);
      return { writes: [{ path, op: 'set', data: after }, ...writes], index, result: undefined };
    });
  }

  async createDocIfMissing(path: string, data: Record<string, any>): Promise<boolean> {
    return this.optimistic([path], ([before]) => {
      if (before) return { result: false };
      const after = clean(data);
      const { writes, index } = this.indexFor(path, null, after);
      return { writes: [{ path, op: 'set', data: after }, ...writes], index, result: true };
    });
  }

  async updateDoc(path: string, data: Record<string, any>): Promise<void> {
    await this.optimistic([path], ([before]) => {
      const after = deepMerge(before?.data ?? {}, clean(data));
      const { writes, index } = this.indexFor(path, before?.data ?? null, after);
      return { writes: [{ path, op: 'merge', data }, ...writes], index, result: undefined };
    });
  }

  async deleteDoc(path: string): Promise<void> {
    await this.optimistic([path], ([before]) => {
      const { writes, index } = this.indexFor(path, before?.data ?? null, null);
      return { writes: [{ path, op: 'delete' }, ...writes], index, result: undefined };
    });
  }

  async deleteTree(path: string): Promise<void> {
    await this.transport.deleteTree(path);
  }

  async listDocs<T = unknown>(collection: string, opts?: { filters?: Filter[]; limit?: number; startAfterId?: string }): Promise<Array<T & { id: string }>> {
    return (await this.transport.list(collection, opts)).map(asValue) as Array<T & { id: string }>;
  }

  async addDoc(collection: string, data: Record<string, any>): Promise<string> {
    const id = this.newId();
    await this.setDoc(`${collection}/${id}`, data);
    return id;
  }

  async compareAndReplaceDoc(path: string, expected: Record<string, any> | null, data: Record<string, any>, effects: ConditionalEffect[] = []): Promise<boolean> {
    const paths = [...new Set([path, ...effects.map(effect => effect.path)])];
    return this.optimistic(paths, docs => {
      const byPath = new Map(paths.map((item, i) => [item, docs[i]!]));
      if (!deepEqual(asValue(byPath.get(path) ?? null), clean(expected))) return { result: false };
      if (effects.some(effect => Object.hasOwn(effect, 'expected') && !deepEqual(asValue(byPath.get(effect.path) ?? null), clean(effect.expected)))) return { result: false };
      const after = clean(data);
      const writes: Write[] = [{ path, op: 'set', data: after }];
      const index = [...this.indexFor(path, byPath.get(path)?.data ?? null, after).index];
      for (const effect of effects) {
        if (effect.guardOnly) continue;
        const before = byPath.get(effect.path)?.data ?? null;
        const result = effect.replace ? clean(effect.data) : deepMerge(before ?? {}, clean(effect.data));
        writes.push({ path: effect.path, op: 'set', data: result });
        index.push(...this.indexFor(effect.path, before, result).index);
      }
      // One outbox write per index path; a later effect supersedes an earlier one.
      const indexWrites = new Map(index.map(item => [item.path, item]));
      writes.push(...[...indexWrites.values()].map(item => item.data ? { path: item.path, op: 'set' as const, data: item.data } : { path: item.path, op: 'delete' as const }));
      return { writes, index: [...indexWrites.values()], result: true };
    });
  }

  async compareAndUpdateDoc<T = unknown>(path: string, check: (current: T & { id: string }) => boolean, data: Record<string, any>): Promise<(T & { id: string }) | null> {
    return this.optimistic([path], ([before]) => {
      const current = asValue(before) as (T & { id: string }) | null;
      if (!current || !check(structuredClone(current))) return { result: null };
      const after = deepMerge(before!.data, clean(data));
      const { writes, index } = this.indexFor(path, before!.data, after);
      return { writes: [{ path, op: 'merge', data }, ...writes], index, result: current };
    });
  }

  /**
   * Coherent reads under `root`: run the work, then confirm nothing under the
   * root changed since it started; otherwise run it again. Writes are refused.
   */
  async readSnapshot<T>(root: string, work: () => Promise<T>): Promise<T> {
    const assertRoot = (path: string) => { if (path !== root && !path.startsWith(`${root}/`)) throw new Error('Read outside publication snapshot'); };
    for (let attempt = 0; attempt < SNAPSHOT_ATTEMPTS; attempt++) {
      const seq = await this.transport.sequence();
      const result = await runReadOnly({
        getDoc: async <D>(path: string) => { assertRoot(path); return this.getDoc<D>(path); },
        listDocs: async <D>(path: string, opts?: { filters?: Filter[]; limit?: number; startAfterId?: string }) => { assertRoot(path); return this.listDocs<D>(path, opts); },
      }, work);
      if (!await this.transport.changedSince(seq, root)) return result;
    }
    throw new ConflictError(root);
  }
}

/** An engine in this process, for local development and offline tests. */
export function localTransport(engine: import('./sql-engine').SqlDocumentEngine): StoreTransport {
  return {
    get: async path => engine.get(path),
    getMany: async paths => engine.getMany(paths),
    list: async (collection, opts) => engine.list(collection, opts),
    commit: async (preconditions, writes) => engine.commit(preconditions, writes),
    deleteTree: async path => engine.deleteTree(path),
    sequence: async () => engine.sequence(),
    changedSince: async (seq, root) => engine.changedSince(seq, root),
  };
}

/** A Durable Object SQLite value is at most 2 MB; keep a margin for the row. */
export const MAX_DOCUMENT_BYTES = 1_900_000;
const MAX_DOCUMENT_DEPTH = 100;

/**
 * Refuse a document the store cannot keep before anything is written, with the
 * same named 422 errors the editor and API already report.
 */
export function assertStorableDocument(path: string, data: Record<string, unknown>): void {
  let text: string;
  try { text = JSON.stringify(data); }
  catch { throw new StorageDocumentError('storage_document_invalid', 'The document contains circular or invalid data. No content was saved.', path); }
  if (new TextEncoder().encode(text).length > MAX_DOCUMENT_BYTES) {
    throw new StorageDocumentError('storage_document_too_large', 'This document is too large to store. Split the content or remove large inline data before saving again.', path);
  }
  const stack: Array<[unknown, number]> = [[data, 1]];
  while (stack.length) {
    const [value, depth] = stack.pop()!;
    if (depth > MAX_DOCUMENT_DEPTH) throw new StorageDocumentError('storage_document_too_deep', 'This document contains too many nested fields for storage. Reduce nesting before saving again.', path);
    if (value && typeof value === 'object') for (const child of Object.values(value)) if (child && typeof child === 'object') stack.push([child, depth + 1]);
  }
}
