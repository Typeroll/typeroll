// Direct document access for the local Playwright run.
//
// The Worker keeps its documents in Durable Objects, which only the Worker
// itself can reach. The suite seeds the fixture content through this route
// (tests/e2e/global-setup.ts) and arranges or inspects the documents a spec
// needs (tests/e2e/helpers/store.ts), as it used to with JSON files.
//
// The route exists only in local E2E mode (lib/local-e2e.ts), only for
// loopback requests and only with the per-run E2E secret; everywhere else it
// answers 404 like a missing route.

import { getStore, type ReadWriteStore } from './datastore';
import { isE2EAuthEnabled, matchesE2EAuthSecret } from './e2e-auth';
import { isLoopbackUrl } from './local-e2e';

export const MAX_E2E_STORE_DOCUMENTS = 500;
export const MAX_E2E_STORE_BYTES = 4 * 1024 * 1024;
const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9_.%:@-]{0,255}$/;

export class E2EStoreError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export interface E2EStoreDocument { path: string; data: Record<string, unknown> }

function isPath(path: unknown, parity: 0 | 1): path is string {
  if (typeof path !== 'string' || path.length > 1024) return false;
  const segments = path.split('/');
  return segments.length % 2 === parity && segments.every(segment => SEGMENT.test(segment) && segment !== '..');
}

/** A document path: collection/id pairs of plain segments. */
export const isDocumentPath = (path: unknown): path is string => isPath(path, 0);
/** A collection path: a document path followed by a collection name. */
export const isCollectionPath = (path: unknown): path is string => isPath(path, 1);

/** Throws E2EStoreError (404) unless the request may use the route at all. */
export function authorizeE2EStore(request: Request): void {
  if (!isE2EAuthEnabled() || !isLoopbackUrl(new URL(request.url))) throw new E2EStoreError('Not found', 404);
  if (!matchesE2EAuthSecret(request.headers.get('x-typeroll-e2e-secret'))) throw new E2EStoreError('Forbidden', 403);
}

function paths(body: Record<string, unknown>, valid: (path: unknown) => path is string): string[] {
  const value = body.paths;
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_E2E_STORE_DOCUMENTS) {
    throw new E2EStoreError(`paths must hold 1 to ${MAX_E2E_STORE_DOCUMENTS} entries`, 400);
  }
  for (const path of value) if (!valid(path)) throw new E2EStoreError(`invalid path ${String(path).slice(0, 200)}`, 400);
  return value as string[];
}

export function parseDocuments(body: Record<string, unknown>): E2EStoreDocument[] {
  const documents = body.documents;
  if (!Array.isArray(documents) || documents.length === 0 || documents.length > MAX_E2E_STORE_DOCUMENTS) {
    throw new E2EStoreError(`documents must hold 1 to ${MAX_E2E_STORE_DOCUMENTS} entries`, 400);
  }
  return documents.map((document: unknown) => {
    const { path, data } = (document ?? {}) as { path?: unknown; data?: unknown };
    if (!isDocumentPath(path)) throw new E2EStoreError(`invalid document path ${String(path).slice(0, 200)}`, 400);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new E2EStoreError(`${path} needs an object`, 400);
    return { path, data: data as Record<string, unknown> };
  });
}

const withoutId = (data: Record<string, unknown>) => {
  const { id: _id, ...rest } = data;
  void _id;
  return rest;
};

/**
 * `set` replaces documents, `get` reads them (null when missing), `delete`
 * removes documents, `delete_tree` removes a document and everything beneath
 * it, `list` reads one collection.
 */
export async function handleE2EStore(body: Record<string, unknown>, store: ReadWriteStore = getStore()): Promise<unknown> {
  switch (body.action) {
    case 'set': {
      const documents = parseDocuments(body);
      for (const { path, data } of documents) await store.setDoc(path, withoutId(data));
      return { written: documents.length };
    }
    case 'get': {
      const documents: Record<string, Record<string, unknown> | null> = {};
      for (const path of paths(body, isDocumentPath)) {
        const document = await store.getDoc<Record<string, unknown>>(path);
        documents[path] = document ? withoutId(document) : null;
      }
      return { documents };
    }
    case 'delete': {
      const targets = paths(body, isDocumentPath);
      for (const path of targets) await store.deleteDoc(path);
      return { deleted: targets.length };
    }
    case 'delete_tree': {
      const targets = paths(body, isDocumentPath);
      for (const path of targets) {
        // Site and organization documents have copies in other objects, which
        // deleteTree cannot reach; deleting the document removes every copy.
        if (/^organizations\/[^/]+(\/sites\/[^/]+)?$/.test(path)) await store.deleteDoc(path);
        else await store.deleteTree(path);
      }
      return { deleted: targets.length };
    }
    case 'list': {
      const [collection] = paths({ paths: [body.collection] }, isCollectionPath);
      return { documents: await store.listDocs(collection!) };
    }
    default:
      throw new E2EStoreError('Unknown action', 400);
  }
}
