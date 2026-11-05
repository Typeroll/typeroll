// A minimal Worker hosting the document store object, for the workerd contract test.
import { DurableObject } from 'cloudflare:workers';
import { documentStoreMethods, type DocumentStoreRpc } from '../../lib/store/durable-object';

export class DocumentStore extends DurableObject {
  private readonly store: DocumentStoreRpc;
  constructor(ctx: any, env: unknown) { super(ctx, env as never); this.store = documentStoreMethods(ctx.storage); }
  get(path: string) { return this.store.get(path); }
  getMany(paths: string[]) { return this.store.getMany(paths); }
  list(collection: string, opts?: Parameters<DocumentStoreRpc['list']>[1]) { return this.store.list(collection, opts); }
  commit(preconditions: Parameters<DocumentStoreRpc['commit']>[0], writes: Parameters<DocumentStoreRpc['commit']>[1]) { return this.store.commit(preconditions, writes); }
  deleteTree(path: string) { return this.store.deleteTree(path); }
  sequence() { return this.store.sequence(); }
  changedSince(seq: number, root: string) { return this.store.changedSince(seq, root); }
}

export default {
  async fetch(request: Request, env: { STORE: any }) {
    const { method, args } = await request.json() as { method: string; args: unknown[] };
    const stub = env.STORE.get(env.STORE.idFromName('site'));
    return Response.json(await stub[method](...args) ?? null);
  },
};
