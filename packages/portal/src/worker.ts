// The portal Worker: Astro's request handler plus the Durable Object classes
// and entry points the platform binds. Runtime configuration (the document
// store) is registered once per isolate before the first request.

import { DurableObject, WorkerEntrypoint, env } from 'cloudflare:workers';
import { handle } from '@astrojs/cloudflare/handler';
import { setRuntimeStore } from './lib/datastore';
import { cloudflareStore, storeObject, type StoreEnv } from './lib/runtime/cloudflare-store';
import { scheduledDocumentStore, type ScheduledDelivery, type ScheduledDocumentStore } from './lib/store/object-scheduler';
import { deliverScheduledWork } from './lib/scheduling/worker';
import { drainObjectOutbox, sweepScheduledObjects } from './lib/scheduling/sweep';
import { createOperatorApi, type OperatorApiMethods } from './lib/operator-api';

setRuntimeStore(() => cloudflareStore(env as unknown as StoreEnv));

interface PortalEnv extends StoreEnv {
  /** Self service binding to the `Scheduler` entrypoint below. */
  SCHEDULER: { deliver(delivery: ScheduledDelivery): Promise<void>; drainOutbox(object: string): Promise<number> };
}

/**
 * One SQLite document database: a site, an organization or the global object.
 * Its alarm delivers the object's own due work and drains its outbox through
 * the `Scheduler` entrypoint, so the work runs as an ordinary Worker
 * invocation rather than inside the object.
 */
export class DocumentStore extends DurableObject<PortalEnv> {
  private readonly store: ScheduledDocumentStore;
  constructor(ctx: DurableObjectState, workerEnv: PortalEnv) {
    super(ctx, workerEnv);
    this.store = scheduledDocumentStore(ctx.storage as never, {
      name: ctx.id.name!,
      hooks: {
        deliver: (delivery: ScheduledDelivery) => workerEnv.SCHEDULER.deliver(delivery),
        drainOutbox: (object: string) => workerEnv.SCHEDULER.drainOutbox(object),
      },
    });
  }
  get(path: string) { return this.store.get(path); }
  getMany(paths: string[]) { return this.store.getMany(paths); }
  list(collection: string, opts?: Parameters<ScheduledDocumentStore['list']>[1]) { return this.store.list(collection, opts); }
  commit(preconditions: Parameters<ScheduledDocumentStore['commit']>[0], writes: Parameters<ScheduledDocumentStore['commit']>[1]) { return this.store.commit(preconditions, writes); }
  deleteTree(path: string) { return this.store.deleteTree(path); }
  sequence() { return this.store.sequence(); }
  changedSince(seq: number, root: string) { return this.store.changedSince(seq, root); }
  exportTree(root: string, afterPath?: string, limit?: number) { return this.store.exportTree(root, afterPath, limit); }
  alarm() { return this.store.alarm(); }
  wake() { return this.store.wake(); }
}

/** Delivery target for store alarms; reachable only through the SCHEDULER binding. */
export class Scheduler extends WorkerEntrypoint<PortalEnv> {
  deliver(delivery: ScheduledDelivery) { return deliverScheduledWork(delivery); }
  drainOutbox(object: string) { return drainObjectOutbox(object); }
}

/**
 * The narrow internal API for the operator Worker. Reachable only through the
 * `CORE_API` service binding that the operator's configuration declares; it
 * has no route on the internet.
 */
export class OperatorApi extends WorkerEntrypoint<PortalEnv> implements OperatorApiMethods {
  readonly #api = createOperatorApi();
  describe() { return this.#api.describe(); }
  getDocument(...args: Parameters<OperatorApiMethods['getDocument']>) { return this.#api.getDocument(...args); }
  getDocuments(...args: Parameters<OperatorApiMethods['getDocuments']>) { return this.#api.getDocuments(...args); }
  listDocuments(...args: Parameters<OperatorApiMethods['listDocuments']>) { return this.#api.listDocuments(...args); }
  commit(...args: Parameters<OperatorApiMethods['commit']>) { return this.#api.commit(...args); }
  listPeople(...args: Parameters<OperatorApiMethods['listPeople']>) { return this.#api.listPeople(...args); }
  getPerson(...args: Parameters<OperatorApiMethods['getPerson']>) { return this.#api.getPerson(...args); }
  updatePerson(...args: Parameters<OperatorApiMethods['updatePerson']>) { return this.#api.updatePerson(...args); }
  revokePersonCredentials(...args: Parameters<OperatorApiMethods['revokePersonCredentials']>) { return this.#api.revokePersonCredentials(...args); }
  seedE2EPersonas(...args: Parameters<OperatorApiMethods['seedE2EPersonas']>) { return this.#api.seedE2EPersonas(...args); }
  inspectE2EPersonas(...args: Parameters<OperatorApiMethods['inspectE2EPersonas']>) { return this.#api.inspectE2EPersonas(...args); }
}

export default {
  fetch: handle,
  /** Safety net every 5 minutes: wake objects whose alarm is overdue. */
  async scheduled(_controller, workerEnv, ctx) {
    ctx.waitUntil(sweepScheduledObjects(object => (storeObject(workerEnv as unknown as StoreEnv, object) as unknown as { wake(): Promise<unknown> }).wake()));
  },
} satisfies ExportedHandler<PortalEnv>;
