// The portal Worker: Astro's request handler plus the Durable Object classes
// and entry points the platform binds. Runtime configuration (the document
// store) is registered once per isolate before the first request.

import { DurableObject, WorkerEntrypoint, env } from 'cloudflare:workers';
import { handle } from '@astrojs/cloudflare/handler';
import { setRuntimeStore } from './lib/datastore';
import { setPublicationTemplateLoader } from './lib/publishing/source-tree';
import { setStoreTransferRuntime } from './lib/runtime/store-transfer';
import { cloudflareMigrationTarget, cloudflareStore, storeObject, type StoreEnv } from './lib/runtime/cloudflare-store';
import { runMigrationStep, type MigrationBucket } from './lib/migration/worker-run';
import { getPortalAuth } from './lib/identity/portal-auth';
import { scheduledDocumentStore, type ScheduledDelivery, type ScheduledDocumentStore } from './lib/store/object-scheduler';
import { deliverScheduledWork } from './lib/scheduling/worker';
import { drainObjectOutbox, sweepScheduledObjects } from './lib/scheduling/sweep';
import { createOperatorApi, type OperatorApiMethods } from './lib/operator-api';
import { setSiteHostingRuntime, type SiteHostingMethods } from './lib/publishing/site-hosting';
import { setLoopbackDispatch } from './lib/runtime/loopback';

setRuntimeStore(() => cloudflareStore(env as unknown as StoreEnv));
// Sites in the `hosted` mode exist only on a deployment that binds a hosting service.
setSiteHostingRuntime(() => (env as unknown as { SITE_HOSTING?: SiteHostingMethods }).SITE_HOSTING ?? null);
setStoreTransferRuntime(() => {
  const target = cloudflareMigrationTarget(env as unknown as StoreEnv);
  const bucket = (env as unknown as { MIGRATION?: MigrationBucket }).MIGRATION;
  return {
    store: target.store,
    object: name => storeObject(env as unknown as StoreEnv, name),
    migration: bucket ? { bucket, target, auth: () => getPortalAuth() } : null,
  };
});
// This release's frozen publication renderer, shipped as a static asset.
setPublicationTemplateLoader(async () => {
  const assets = (env as unknown as { ASSETS: { fetch(request: Request): Promise<Response> } }).ASSETS;
  const response = await assets.fetch(new Request('https://assets.invalid/_typeroll/publication-template.json'));
  if (!response.ok) throw new Error('This release has no bundled publication renderer');
  return response.text();
});

// A Worker cannot fetch its own hostname (Cloudflare answers 522), so
// requests to the portal's own origin go through the self binding below.
setLoopbackDispatch(request => (env as unknown as PortalEnv).SCHEDULER.fetch(request));

interface PortalEnv extends StoreEnv {
  /** EU-jurisdiction bucket holding cutover exports and checkpoints. */
  MIGRATION?: MigrationBucket;
  /** `allow` only during the cutover window. */
  TYPEROLL_MIGRATION?: string;
  /** The hosting service for sites in the `hosted` mode (publishing/site-hosting.ts); absent on most deployments. */
  SITE_HOSTING?: SiteHostingMethods;
  /** Self service binding to the `Scheduler` entrypoint below. */
  SCHEDULER: {
    deliver(delivery: ScheduledDelivery): Promise<void>;
    drainOutbox(object: string): Promise<number>;
    fetch(request: Request): Promise<Response>;
  };
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
  paths(after?: string, limit?: number) { return this.store.paths(after, limit); }
  alarm() { return this.store.alarm(); }
  wake() { return this.store.wake(); }
}

/**
 * Delivery target for store alarms, and the in-process route for requests to
 * the portal's own origin (lib/runtime/loopback.ts). Reachable only through
 * the SCHEDULER self binding; it has no route on the internet.
 */
export class Scheduler extends WorkerEntrypoint<PortalEnv> {
  deliver(delivery: ScheduledDelivery) { return deliverScheduledWork(delivery); }
  drainOutbox(object: string) { return drainObjectOutbox(object); }
  fetch(request: Request) { return handle(request, this.env as never, this.ctx as never); }
}

/**
 * The narrow internal API for the operator Worker. Reachable only through the
 * `CORE_API` service binding that the operator's configuration declares; it
 * has no route on the internet.
 */
export class OperatorApi extends WorkerEntrypoint<PortalEnv> implements OperatorApiMethods {
  readonly #api = createOperatorApi({
    migration: this.env.MIGRATION ? request => runMigrationStep({
      bucket: this.env.MIGRATION!, target: cloudflareMigrationTarget(this.env), auth: () => getPortalAuth(),
      enabled: this.env.TYPEROLL_MIGRATION === 'allow',
    }, request) : undefined,
  });
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
  runMigrationStep(...args: Parameters<OperatorApiMethods['runMigrationStep']>) { return this.#api.runMigrationStep(...args); }
}

export default {
  fetch: handle,
  /** Safety net every 5 minutes: wake objects whose alarm is overdue. */
  async scheduled(_controller, workerEnv, ctx) {
    ctx.waitUntil(sweepScheduledObjects(object => (storeObject(workerEnv as unknown as StoreEnv, object) as unknown as { wake(): Promise<unknown> }).wake()));
  },
} satisfies ExportedHandler<PortalEnv>;
