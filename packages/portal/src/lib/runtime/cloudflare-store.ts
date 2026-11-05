// The document store on Cloudflare: a ShardedStore whose objects are Durable
// Objects of one class (`DocumentStore`, binding `STORE`). Every stub is
// created in the EU jurisdiction. Only local development (workerd has no
// jurisdictions) may set STORE_JURISDICTION=none, in `.dev.vars`.

import { ShardedStore } from '../store/sharded-store';
import { durableObjectTransport, type DocumentStoreRpc } from '../store/durable-object';
import { generateDocId } from '../datastore';

export interface DurableObjectNamespaceLike {
  jurisdiction(name: 'eu'): DurableObjectNamespaceLike;
  idFromName(name: string): unknown;
  get(id: unknown): unknown;
}

export interface StoreEnv { STORE: DurableObjectNamespaceLike; STORE_JURISDICTION?: string }

/** The stub of one store object, always in the EU jurisdiction. */
export function storeObject(env: StoreEnv, name: string): DocumentStoreRpc {
  const namespace = env.STORE_JURISDICTION === 'none' ? env.STORE : env.STORE.jurisdiction('eu');
  return namespace.get(namespace.idFromName(name)) as DocumentStoreRpc;
}

/**
 * Stubs are I/O objects bound to the request that created them, while the
 * store (and its per-object SqlStores) lives for the whole isolate. Every call
 * therefore resolves a fresh stub.
 */
export function lazyObject(env: StoreEnv, name: string): DocumentStoreRpc {
  return new Proxy({} as DocumentStoreRpc, {
    get: (_target, method: string) => (...args: unknown[]) =>
      (storeObject(env, name) as unknown as Record<string, (...a: unknown[]) => unknown>)[method]!(...args),
  });
}

export function cloudflareStore(env: StoreEnv): ShardedStore {
  return new ShardedStore({ transport: name => durableObjectTransport(lazyObject(env, name) as never) }, generateDocId);
}
