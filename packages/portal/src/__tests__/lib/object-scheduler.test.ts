// Scheduled work delivered by store-object alarms, with a fake clock.
//
// Each "object" is the real Durable Object store code (scheduledDocumentStore)
// on node:sqlite with an in-memory alarm; the portal executor runs against a
// ShardedStore over them, as on Cloudflare. The test fires alarms itself, in
// time order, so an hour of delivery takes milliseconds.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ retry: vi.fn(), media: vi.fn() }));
vi.mock('../../lib/forms/webhook', () => ({ retryFormWebhookDelivery: mocks.retry }));
vi.mock('../../lib/publishing/media-migration', () => ({ executeMediaMigration: mocks.media }));
import { setRuntimeStore } from '../../lib/datastore';
import { nodeSqliteDriver } from '../../lib/store/node-sqlite';
import { durableObjectTransport } from '../../lib/store/durable-object';
import { ShardedStore } from '../../lib/store/sharded-store';
import { REPORT_ENTRY, SCHEDULED_OBJECTS, scheduledDocumentStore, type AlarmStorage, type ScheduledDocumentStore } from '../../lib/store/object-scheduler';
import type { StoreTransport } from '../../lib/store/sql-store';
import { putScheduledWork, workPath, type ScheduledWork } from '../../lib/scheduling/index';
import { deliverScheduledWork } from '../../lib/scheduling/worker';
import { OUTBOX_GRACE_MS, SWEEP_GRACE_MS, drainObjectOutbox, sweepScheduledObjects } from '../../lib/scheduling/sweep';
import { CHAIN_FLOOR_MS } from '../../lib/scheduling/chain';
import { enqueueMediaMigration } from '../../lib/publishing/media-migration-queue';

const T0 = Date.parse('2026-11-05T12:00:00.000Z');
const SITE = 'organizations/o/sites/s';
const source = (name: string) => `${SITE}/form_webhook_deliveries/${name}`;
const NEVER = Number.MAX_SAFE_INTEGER;

interface FakeObject { storage: AlarmStorage & { alarm: number | null }; store: ScheduledDocumentStore }

function fakeStorage(): FakeObject['storage'] {
  const driver = nodeSqliteDriver();
  const storage = {
    alarm: null as number | null,
    // Runs at once, as workerd's sql.exec does; toArray only reads the result.
    sql: { exec: (query: string, ...params: unknown[]) => { const rows = driver.exec(query, ...params); return { toArray: () => rows }; } },
    transactionSync: <T>(work: () => T) => driver.transaction(work),
    getAlarm: async () => storage.alarm,
    setAlarm: async (time: number) => { storage.alarm = time; },
    deleteAlarm: async () => { storage.alarm = null; },
  };
  return storage;
}

/** Store objects plus the Worker side (executor, outbox drain), wired as on Cloudflare. */
class Platform {
  readonly objects = new Map<string, FakeObject>();
  readonly sharded: ShardedStore;
  failing = new Set<string>();
  deliveries = 0;
  private ids = 0;

  constructor() {
    this.sharded = new ShardedStore({ transport: name => this.transport(name) }, () => `doc${++this.ids}`);
  }

  object(name: string): FakeObject {
    let object = this.objects.get(name);
    if (!object) {
      const storage = fakeStorage();
      const store = scheduledDocumentStore(storage, { name, hooks: {
        deliver: async delivery => { this.deliveries++; await deliverScheduledWork(delivery); },
        drainOutbox: object => drainObjectOutbox(object),
      } });
      object = { storage, store };
      this.objects.set(name, object);
    }
    return object;
  }

  private transport(name: string): StoreTransport {
    const transport = durableObjectTransport(this.object(name).store as never);
    return { ...transport, commit: async (...args) => {
      if (this.failing.has(name)) throw new Error('object unavailable');
      return transport.commit(...args);
    } };
  }

  /** Fire alarms in time order up to `until`, moving the clock to each. */
  async runUntil(until: number, limit = 10_000): Promise<number> {
    let fired = 0;
    for (; fired < limit; fired++) {
      const next = [...this.objects.values()].filter(object => object.storage.alarm !== null)
        .sort((a, b) => a.storage.alarm! - b.storage.alarm!)[0];
      if (!next || next.storage.alarm! > until) break;
      vi.setSystemTime(Math.max(Date.now(), next.storage.alarm!));
      await next.store.alarm();
    }
    vi.setSystemTime(Math.max(Date.now(), until));
    return fired;
  }

  async siteObject() { return this.object(await this.sharded.shardName(SITE)); }
}

let platform: Platform;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  mocks.retry.mockReset().mockResolvedValue(null);
  mocks.media.mockReset().mockResolvedValue(null);
  platform = new Platform();
  setRuntimeStore(() => platform.sharded);
});
afterEach(() => { setRuntimeStore(null); vi.useRealTimers(); vi.restoreAllMocks(); });

/** When the object's schedule next wants a delivery; its alarm is at or before this (outbox drains come first). */
const workDue = (object: FakeObject) => (object.storage.sql.exec('SELECT MIN(MAX(ready_at, retry_at)) AS t FROM scheduling_due').toArray()[0] as { t: number | null }).t;
const put = (name: string, due: number) => putScheduledWork({ kind: 'form_webhook_retry', source: source(name), due_at: due, payload: {} });
const work = async (name: string) => (await platform.siteObject()).store.get(workPath(source(name), 'form_webhook_retry'))?.data as ScheduledWork | undefined;

it('keeps scheduled work in its source object and arms that object at the earliest due item', async () => {
  await put('late', T0 + 60_000);
  await put('early', T0 + 10_000);
  const site = await platform.siteObject();
  expect(site.store.get(workPath(source('early'), 'form_webhook_retry'))).not.toBeNull();
  expect(platform.object('global').store.get(workPath(source('early'), 'form_webhook_retry'))).toBeNull();
  expect(site.storage.alarm).toBe(T0 + 10_000);
});

it('delivers due work once, then re-arms for the next item', async () => {
  await put('a', T0 + 10_000);
  await put('b', T0 + 60_000);
  const site = await platform.siteObject();
  await platform.runUntil(T0 + 10_000);
  expect(mocks.retry).toHaveBeenCalledExactlyOnceWith(source('a'), T0 + 10_000);
  expect((await work('a'))!.due_at).toBe(NEVER);
  expect(workDue(site)).toBe(T0 + 60_000);
  expect(site.storage.alarm).toBeLessThanOrEqual(T0 + 60_000);
  // A repeated alarm at the same time does not deliver again.
  await site.store.alarm();
  expect(mocks.retry).toHaveBeenCalledOnce();
  await platform.runUntil(T0 + 60_000);
  expect(mocks.retry).toHaveBeenCalledTimes(2);
  expect(mocks.retry).toHaveBeenLastCalledWith(source('b'), T0 + 60_000);
});

it('follows a postponed item to its new due time', async () => {
  await put('a', T0 + 1_000);
  mocks.retry.mockResolvedValueOnce(T0 + 3_600_000);
  await platform.runUntil(T0 + 1_000);
  expect(workDue(await platform.siteObject())).toBe(T0 + 3_600_000);
  await platform.runUntil(T0 + 3_600_000);
  expect(mocks.retry).toHaveBeenCalledTimes(2);
});

it('retries a failed delivery with growing backoff, never in a tight loop', async () => {
  await put('a', T0 + 1_000);
  mocks.retry.mockRejectedValueOnce(new Error('crash')).mockRejectedValueOnce(new Error('crash')).mockRejectedValueOnce(new Error('crash'));
  const site = await platform.siteObject();
  const seen: number[] = [];
  for (let i = 0; i < 3; i++) { await platform.runUntil(workDue(site)!); seen.push(workDue(site)! - Date.now()); }
  expect(seen).toEqual([5_000, 10_000, 20_000]);
  await platform.runUntil(workDue(site)!);
  expect(mocks.retry).toHaveBeenCalledTimes(4);
  expect((await work('a'))!.due_at).toBe(NEVER);
});

it('converges after a crash between the commit and its delivery', async () => {
  // The Worker dies while delivering: the object retries the same generation.
  await put('a', T0 + 1_000);
  mocks.retry.mockRejectedValueOnce(new Error('worker crashed'));
  await platform.runUntil(T0 + 1_000);
  expect(mocks.retry).toHaveBeenCalledOnce();
  expect((await work('a'))!.due_at).toBe(T0 + 1_000);
  await platform.runUntil(T0 + 6_000);
  expect(mocks.retry).toHaveBeenCalledTimes(2);
  expect((await work('a'))!.due_at).toBe(NEVER);
});

it('recovers work whose schedule and alarm were lost, through the sweep', async () => {
  await put('a', T0 + 3_600_000);
  await platform.runUntil(T0 + OUTBOX_GRACE_MS);
  // The object's schedule and alarm are gone; the durable document is not.
  const site = await platform.siteObject();
  site.storage.sql.exec('DELETE FROM scheduling_due');
  await site.storage.deleteAlarm();
  expect(await platform.runUntil(T0 + 7_200_000)).toBe(0);
  expect(mocks.retry).not.toHaveBeenCalled();
  const swept = await sweepScheduledObjects(name => platform.object(name).store.wake());
  expect(swept.poked).toEqual([await platform.sharded.shardName(SITE)]);
  await platform.runUntil(Date.now());
  expect(mocks.retry).toHaveBeenCalledOnce();
  expect((await work('a'))!.due_at).toBe(NEVER);
});

it('reports pending objects to the global index through its outbox and clears the row when done', async () => {
  await put('a', T0 + 3_600_000);
  const site = await platform.siteObject(), name = await platform.sharded.shardName(SITE);
  expect(site.store.get(REPORT_ENTRY)).not.toBeNull();
  expect(site.storage.alarm).toBe(T0 + OUTBOX_GRACE_MS);
  await platform.runUntil(T0 + OUTBOX_GRACE_MS);
  expect(site.store.get(REPORT_ENTRY)).toBeNull();
  expect(await platform.sharded.getDoc(`${SCHEDULED_OBJECTS}/${name}`)).toEqual({ id: name, object: name, due_at: T0 + 3_600_000 });
  expect(site.storage.alarm).toBe(T0 + 3_600_000);
  // A lost alarm: the sweep finds the object only after the grace period.
  await site.storage.deleteAlarm();
  vi.setSystemTime(T0 + 3_600_000 + SWEEP_GRACE_MS - 1);
  expect((await sweepScheduledObjects(object => platform.object(object).store.wake())).poked).toEqual([]);
  vi.setSystemTime(T0 + 3_600_000 + SWEEP_GRACE_MS);
  expect((await sweepScheduledObjects(object => platform.object(object).store.wake())).poked).toEqual([name]);
  await platform.runUntil(Date.now() + OUTBOX_GRACE_MS);
  expect(mocks.retry).toHaveBeenCalledOnce();
  expect(await platform.sharded.getDoc(`${SCHEDULED_OBJECTS}/${name}`)).toBeNull();
  expect(site.storage.alarm).toBeNull();
});

it('drains an outbox entry a crash left behind, from the alarm', async () => {
  platform.failing.add('org:o');
  await expect(platform.sharded.setDoc(SITE, { name: 'Site' })).rejects.toThrow('object unavailable');
  platform.failing.clear();
  expect(await platform.sharded.listDocs('organizations/o/sites')).toEqual([]);
  const site = await platform.siteObject();
  expect(site.storage.alarm).toBe(T0 + OUTBOX_GRACE_MS);
  // Edited again before the drain: the drain copies the current document, not the stale snapshot.
  site.store.commit([], [{ path: SITE, op: 'merge', data: { name: 'Renamed' } }]);
  await platform.runUntil(T0 + OUTBOX_GRACE_MS);
  expect(await platform.sharded.listDocs('organizations/o/sites')).toEqual([{ id: 's', name: 'Renamed' }]);
  expect(site.store.list('_outbox')).toEqual([]);
  expect(site.storage.alarm).toBeNull();
});

it('keeps a stuck media preparation chain bounded over an hour of alarms', async () => {
  // The work always asks to run again at once: the chain floor, not the work, sets the pace.
  mocks.media.mockResolvedValue(0);
  await enqueueMediaMigration('o');
  await enqueueMediaMigration('o');
  await platform.runUntil(T0 + 3_600_000);
  const runs = mocks.media.mock.calls.length;
  expect(runs).toBeGreaterThan(600);
  expect(runs).toBeLessThanOrEqual(3_600_000 / CHAIN_FLOOR_MS + 1);
  expect(platform.deliveries).toBeLessThanOrEqual(runs + 1);
});
