// The operator's document surface over the portal's store, restricted to the
// families in paths.ts. A commit maps onto compareAndReplaceDoc: one written
// (or re-written) document carries the condition, the other reads become
// guard-only effects and the other writes whole-document replacements.

import type { ConditionalEffect, Filter, ReadWriteStore } from '../datastore';
import {
  MAX_BATCH, MAX_COMMIT_DOCUMENTS, MAX_PAGE, OperatorApiError,
  type ApiDocument, type CommitRequest, type CommitResult, type DocumentData, type DocumentPage, type ListOptions,
} from './contract';
import { assertCollection, assertDocument, commitScope } from './paths';

const ATTEMPTS = 8;
/** Set on a guarded document between its conditional commit and its deletion. */
export const DELETING = '_operator_deleting';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function body(data: DocumentData): DocumentData {
  const { id: _id, ...rest } = data;
  void _id;
  return rest;
}

function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const x = a as Record<string, unknown>, y = b as Record<string, unknown>;
  const keys = Object.keys(x).filter(key => x[key] !== undefined);
  if (keys.length !== Object.keys(y).filter(key => y[key] !== undefined).length) return false;
  return keys.every(key => Object.hasOwn(y, key) && equal(x[key], y[key]));
}

export class OperatorDocuments {
  constructor(private readonly store: () => ReadWriteStore) {}

  async getDocument(path: string): Promise<ApiDocument | null> {
    assertDocument(path, 'read');
    return (await this.store().getDoc<DocumentData>(path)) as ApiDocument | null;
  }

  async getDocuments(paths: string[]): Promise<Array<ApiDocument | null>> {
    if (!Array.isArray(paths) || paths.length > MAX_BATCH) throw new OperatorApiError('invalid_request', `between 0 and ${MAX_BATCH} paths are required`);
    for (const path of paths) assertDocument(path, 'read');
    const store = this.store();
    return Promise.all(paths.map(path => store.getDoc<DocumentData>(path) as Promise<ApiDocument | null>));
  }

  async listDocuments(collection: string, options: ListOptions = {}): Promise<DocumentPage> {
    assertCollection(collection);
    if (typeof options !== 'object' || options === null || Array.isArray(options)) throw new OperatorApiError('invalid_request', 'options must be an object');
    const limit = options.limit ?? MAX_PAGE;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE) throw new OperatorApiError('invalid_request', `limit must be 1–${MAX_PAGE}`);
    if (options.startAfterId !== undefined && (typeof options.startAfterId !== 'string' || options.startAfterId.length > 512)) {
      throw new OperatorApiError('invalid_request', 'startAfterId must be a document id');
    }
    const filters: Filter[] = [];
    for (const filter of options.filters ?? []) {
      const valid = isRecord(filter) && typeof filter.field === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(filter.field)
        && (filter.value === null || ['string', 'number', 'boolean'].includes(typeof filter.value));
      if (!valid) throw new OperatorApiError('invalid_request', 'filters compare one field with a primitive value');
      filters.push({ field: filter.field, op: '==', value: filter.value });
    }
    const documents = await this.store().listDocs<DocumentData>(collection, {
      filters: filters.length ? filters : undefined, limit, startAfterId: options.startAfterId ?? '',
    }) as ApiDocument[];
    return { documents, next: documents.length === limit ? documents.at(-1)!.id : null };
  }

  async commit(request: CommitRequest): Promise<CommitResult> {
    const { reads, writes } = validate(request);
    const store = this.store();
    const readMap = new Map(reads.map(read => [read.path, read.value] as const));
    const scopes = new Set(reads.map(read => commitScope(read.path)));
    if (scopes.size > 1) throw new OperatorApiError('cross_scope_condition', `reads span ${[...scopes].join(', ')}; conditions must lie in one site, one organization or the global collections`);
    const scope = [...scopes][0];
    const data = writes.filter((write): write is { path: string; data: DocumentData } => write.data !== null);
    const deletes = writes.filter(write => write.data === null).map(write => write.path);

    // The document compareAndReplaceDoc writes: a conditional write if there is
    // one, a write in the reads' scope, or else a guarded document re-written
    // unchanged so the check stays atomic.
    // A guarded document that will be deleted is first marked, so a concurrent
    // commit conditioned on its old value fails instead of deleting it twice.
    const marked = (path: string) => ({ path, data: { ...body(readMap.get(path)!), [DELETING]: true } });
    let main: { path: string; data: DocumentData } | undefined =
      data.find(write => readMap.has(write.path)) ?? data.find(write => scope === undefined || commitScope(write.path) === scope);
    if (!main && reads.length) {
      const guarded = deletes.find(path => readMap.get(path));
      if (guarded) main = marked(guarded);
      else {
        const present = reads.find(read => read.value)?.path;
        if (present) main = { path: present, data: body(readMap.get(present)!) };
      }
    }

    if (!main) {
      // Only absent-document conditions and writes outside their scope remain.
      for (const read of reads) if (!equal(await store.getDoc(read.path), read.value)) return { ok: false };
      for (const write of data) await store.setDoc(write.path, body(write.data));
      for (const path of deletes) await store.deleteDoc(path);
      return { ok: true };
    }

    const effects: ConditionalEffect[] = [];
    for (const read of reads) {
      if (read.path === main.path) continue;
      const write = data.find(item => item.path === read.path) ?? (read.value && deletes.includes(read.path) ? marked(read.path) : undefined);
      effects.push(write
        ? { path: read.path, data: body(write.data), replace: true, expected: read.value }
        : { path: read.path, data: {}, guardOnly: true, expected: read.value });
    }
    for (const write of data) {
      if (write.path !== main.path && !readMap.has(write.path)) effects.push({ path: write.path, data: body(write.data), replace: true });
    }

    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const expected = readMap.has(main.path) ? readMap.get(main.path)! : await store.getDoc<DocumentData>(main.path);
      if (await store.compareAndReplaceDoc(main.path, expected, body(main.data), effects)) {
        for (const path of deletes) await store.deleteDoc(path);
        return { ok: true };
      }
      // The caller's condition failed, or only the unconditional main document moved.
      if (readMap.has(main.path)) return { ok: false };
      for (const read of reads) if (!equal(await store.getDoc(read.path), read.value)) return { ok: false };
    }
    throw new OperatorApiError('conflict', `${main.path} is changing too often; retry the operation`);
  }
}

function validate(request: CommitRequest): CommitRequest {
  if (!isRecord(request) || !Array.isArray(request.reads) || !Array.isArray(request.writes)) {
    throw new OperatorApiError('invalid_request', 'a commit needs reads and writes');
  }
  if (request.reads.length + request.writes.length > MAX_COMMIT_DOCUMENTS) {
    throw new OperatorApiError('invalid_request', `a commit covers at most ${MAX_COMMIT_DOCUMENTS} documents`);
  }
  const seenReads = new Set<string>(), seenWrites = new Set<string>();
  for (const read of request.reads) {
    if (!isRecord(read) || (read.value !== null && !isRecord(read.value))) throw new OperatorApiError('invalid_request', 'a read is a path and its document or null');
    assertDocument(read.path, 'read');
    if (seenReads.has(read.path)) throw new OperatorApiError('invalid_request', `duplicate read ${read.path}`);
    seenReads.add(read.path);
  }
  for (const write of request.writes) {
    if (!isRecord(write) || (write.data !== null && !isRecord(write.data))) throw new OperatorApiError('invalid_request', 'a write is a path and its data or null');
    assertDocument(write.path, write.data === null ? 'delete' : 'write');
    if (seenWrites.has(write.path)) throw new OperatorApiError('invalid_request', `duplicate write ${write.path}`);
    seenWrites.add(write.path);
  }
  return request;
}
