// Where scheduled work lives.
//
// `scheduled_work/<id>` is a collection local to the store object that holds
// its source: a site's work in the site object, an organization's in its
// object. In a single store (local development, tests) that is the store
// itself. In the sharded store the bare path would route to the global
// object, so every access goes through these helpers.

import { getStore, type ReadWriteStore } from '../datastore';

interface ObjectRouter {
  shardName(path: string): Promise<string>;
  objectStore(name: string): ReadWriteStore;
}

const router = (store: ReadWriteStore): (ReadWriteStore & ObjectRouter) | null =>
  typeof (store as Partial<ObjectRouter>).objectStore === 'function' && typeof (store as Partial<ObjectRouter>).shardName === 'function'
    ? store as ReadWriteStore & ObjectRouter : null;

/** The store object holding the scheduled work of `source`, and its name (null in a single store). */
export async function workLocation(source: string): Promise<{ store: ReadWriteStore; object: string | null }> {
  const store = getStore(), sharded = router(store);
  if (!sharded) return { store, object: null };
  const object = await sharded.shardName(source);
  return { store: sharded.objectStore(object), object };
}

/** The store of a named object from a delivery; the single store when there is no name. */
export function objectWorkStore(object?: string | null): ReadWriteStore {
  const store = getStore();
  if (!object) return store;
  const sharded = router(store);
  if (!sharded) throw new Error('A delivery from a store object needs the sharded store');
  return sharded.objectStore(object);
}
