// Documents of the local E2E Worker's store, for arranging and inspecting what
// a spec needs (the suite used to edit JSON fixture files for this). Paths are
// store document paths such as
// `organizations/default/sites/default/versions/main/pages/home`.
// Local target only: the route answers 404 everywhere else.
import { e2eStoreRequest } from '../seed-store.mjs';

export const PORTAL_ORIGIN = new URL(process.env.TYPEROLL_E2E_PORTAL_URL ?? 'http://127.0.0.1:4322').origin;
/** The default local site and its main version. */
export const DEFAULT_SITE = 'organizations/default/sites/default';
export const DEFAULT_MAIN = `${DEFAULT_SITE}/versions/main`;
/** The Core persona fixture site and its main version. */
export const CORE_SITE = 'organizations/e2e-core/sites/e2e-core-site';
export const CORE_MAIN = `${CORE_SITE}/versions/main`;

type Data = Record<string, any>;

function request<T>(body: Record<string, unknown>): Promise<T> {
  return e2eStoreRequest({ portalUrl: PORTAL_ORIGIN, secret: process.env.TYPEROLL_E2E_AUTH_SECRET, body }) as Promise<T>;
}

export const e2eStore = {
  /** The document without its id, or null. */
  async get<T extends Data = Data>(path: string): Promise<T | null> {
    const { documents } = await request<{ documents: Record<string, T | null> }>({ action: 'get', paths: [path] });
    return documents[path] ?? null;
  },
  /** The document; fails the spec when it is missing. */
  async read<T extends Data = Data>(path: string): Promise<T> {
    const document = await e2eStore.get<T>(path);
    if (!document) throw new Error(`[e2e-store] ${path} does not exist`);
    return document;
  },
  /** Replace the document (an `id` field is ignored). */
  async set(path: string, data: Data): Promise<void> {
    await request({ action: 'set', documents: [{ path, data }] });
  },
  async setMany(documents: Array<[string, Data]>): Promise<void> {
    if (documents.length) await request({ action: 'set', documents: documents.map(([path, data]) => ({ path, data })) });
  },
  async delete(...paths: string[]): Promise<void> {
    if (paths.length) await request({ action: 'delete', paths });
  },
  /** Delete documents and everything beneath them (revisions, subcollections). */
  async deleteTree(...paths: string[]): Promise<void> {
    if (paths.length) await request({ action: 'delete_tree', paths });
  },
  async list<T extends Data = Data>(collection: string): Promise<Array<T & { id: string }>> {
    return (await request<{ documents: Array<T & { id: string }> }>({ action: 'list', collection })).documents;
  },
  /**
   * Run `work` with `path` replaced by `change(original)` and restore the
   * original afterwards (or delete the document when there was none).
   */
  async withDocument<T>(path: string, change: (original: Data | null) => Data, work: () => Promise<T>): Promise<T> {
    const original = await e2eStore.get(path);
    await e2eStore.set(path, change(original));
    try { return await work(); }
    finally {
      if (original) await e2eStore.set(path, original);
      else await e2eStore.delete(path);
    }
  },
};
