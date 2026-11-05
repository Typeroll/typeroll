// A Worker hosting store objects with their alarm schedule, for the workerd
// scheduling test. Wired as the portal Worker should be: the object's alarm
// calls a Worker entrypoint through a self service binding (`SCHEDULER`), and
// that invocation reaches the objects through fresh stubs.
import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';
import { durableObjectTransport } from '../../lib/store/durable-object';
import { scheduledDocumentStore, type ScheduledDelivery, type ScheduledDocumentStore } from '../../lib/store/object-scheduler';
import { ShardedStore } from '../../lib/store/sharded-store';

interface Env { STORE: any; SCHEDULER: { deliver(delivery: ScheduledDelivery): Promise<void>; drainOutbox(object: string): Promise<number> } }
const NEVER = Number.MAX_SAFE_INTEGER;
const stub = (env: Env, name: string) => env.STORE.get(env.STORE.idFromName(name));

export class DocumentStore extends DurableObject<Env> {
  private readonly store: ScheduledDocumentStore;
  private readonly storage: any;
  constructor(ctx: any, env: Env) {
    super(ctx, env);
    this.storage = ctx.storage;
    this.store = scheduledDocumentStore(ctx.storage, {
      name: ctx.id.name,
      hooks: { deliver: delivery => env.SCHEDULER.deliver(delivery), drainOutbox: object => env.SCHEDULER.drainOutbox(object) },
      // Short delays so real alarms fire within the test.
      retryFloorMs: 200, outboxGraceMs: 300,
    });
  }
  get(path: string) { return this.store.get(path); }
  getMany(paths: string[]) { return this.store.getMany(paths); }
  list(collection: string, opts?: any) { return this.store.list(collection, opts); }
  commit(preconditions: any[], writes: any[]) { return this.store.commit(preconditions, writes); }
  deleteTree(path: string) { return this.store.deleteTree(path); }
  sequence() { return this.store.sequence(); }
  changedSince(seq: number, root: string) { return this.store.changedSince(seq, root); }
  exportTree(root: string, afterPath?: string, limit?: number) { return this.store.exportTree(root, afterPath, limit); }
  alarm() { return this.store.alarm(); }
  wake() { return this.store.wake(); }
  alarmAt() { return this.storage.getAlarm(); }
}

/** The Worker side: a minimal executor (the portal binds deliverScheduledWork) and the real outbox drain. */
export class Scheduler extends WorkerEntrypoint<Env> {
  async deliver(delivery: ScheduledDelivery) {
    const object = stub(this.env, delivery.object), path = `scheduled_work/${delivery.id}`;
    const current = await object.get(path);
    if (!current || current.data.generation !== delivery.generation || current.data.due_at >= NEVER) return;
    const crash = await object.get('control/crash');
    if (crash?.data.remaining > 0) {
      await object.commit([], [{ path: 'control/crash', op: 'set', data: { remaining: crash.data.remaining - 1 } }]);
      throw new Error('synthetic worker crash');
    }
    const record = `deliveries/${delivery.id}-${delivery.generation}`;
    const seen = await object.get(record);
    // The work is consumed in the same commit that records the delivery, guarded by its revision.
    await object.commit([{ path, revision: current.revision }, { path: record, revision: seen?.revision ?? null }],
      [{ path: record, op: 'set', data: { count: (seen?.data.count ?? 0) + 1, at: Date.now() } }, { path, op: 'merge', data: { due_at: NEVER } }]);
  }
  async drainOutbox(object: string) {
    return new ShardedStore({ transport: name => durableObjectTransport(stub(this.env, name)) }, () => crypto.randomUUID()).drainOutbox(object, { minAgeMs: 300 });
  }
}

export default {
  async fetch(request: Request, env: Env) {
    const { object, method, args } = await request.json() as { object: string; method: string; args: unknown[] };
    return Response.json(await stub(env, object)[method](...args) ?? null);
  },
};
