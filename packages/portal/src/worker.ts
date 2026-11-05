// The portal Worker: Astro's request handler plus the Durable Object classes
// and entry points the platform binds. Runtime configuration (the document
// store) is registered once per isolate before the first request.

import { DurableObject, env } from 'cloudflare:workers';
import { handle } from '@astrojs/cloudflare/handler';
import { setRuntimeStore } from './lib/datastore';
import { cloudflareStore, type StoreEnv } from './lib/runtime/cloudflare-store';
import { documentStoreMethods, type DocumentStoreRpc } from './lib/store/durable-object';

setRuntimeStore(() => cloudflareStore(env as unknown as StoreEnv));

/** One SQLite document database: a site, an organization or the global object. */
export class DocumentStore extends DurableObject {
  private readonly store: DocumentStoreRpc;
  constructor(ctx: DurableObjectState, workerEnv: unknown) {
    super(ctx, workerEnv as never);
    this.store = documentStoreMethods(ctx.storage as never);
  }
  get(path: string) { return this.store.get(path); }
  getMany(paths: string[]) { return this.store.getMany(paths); }
  list(collection: string, opts?: Parameters<DocumentStoreRpc['list']>[1]) { return this.store.list(collection, opts); }
  commit(preconditions: Parameters<DocumentStoreRpc['commit']>[0], writes: Parameters<DocumentStoreRpc['commit']>[1]) { return this.store.commit(preconditions, writes); }
  deleteTree(path: string) { return this.store.deleteTree(path); }
  sequence() { return this.store.sequence(); }
  changedSince(seq: number, root: string) { return this.store.changedSince(seq, root); }
  exportTree(root: string, afterPath?: string, limit?: number) { return this.store.exportTree(root, afterPath, limit); }
}

export default {
  fetch: handle,
} satisfies ExportedHandler;
