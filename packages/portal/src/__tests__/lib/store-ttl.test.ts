// The store's TTL: a document with a past `delete_at` is removed by the alarm
// of the object that holds it, without any Cron job.
import { expect, it } from 'vitest';
import { SqlDocumentEngine, expiryOf } from '../../lib/store/sql-engine';
import { nodeSqliteDriver } from '../../lib/store/node-sqlite';
import { scheduledDocumentStore, type AlarmStorage } from '../../lib/store/object-scheduler';
import { SqlStore } from '../../lib/store/sql-store';
import { durableObjectTransport } from '../../lib/store/durable-object';
import { consumeRateLimit } from '../../lib/identity/store-adapter';

const T0 = Date.parse('2026-11-05T12:00:00.000Z');
const STEP = 15 * 60_000;
const set = (engine: SqlDocumentEngine, path: string, data: Record<string, unknown>) =>
  expect(engine.commit([], [{ path, op: 'set', data }])).toMatchObject({ ok: true });

it('reads delete_at as epoch milliseconds, an ISO date or a Date', () => {
  expect(expiryOf({ delete_at: T0 })).toBe(T0);
  expect(expiryOf({ delete_at: new Date(T0).toISOString() })).toBe(T0);
  expect(expiryOf({ delete_at: new Date(T0) })).toBe(T0);
  expect(expiryOf({ delete_at: null })).toBeNull();
  expect(expiryOf({ delete_at: 'soon' })).toBeNull();
  expect(expiryOf({ expires_at: T0 })).toBeNull();
});

it('removes only documents whose delete_at has passed, and follows rewrites', () => {
  const engine = new SqlDocumentEngine(nodeSqliteDriver());
  set(engine, 'a/1', { delete_at: T0 - 1 });
  set(engine, 'a/2', { delete_at: new Date(T0 + 60_000).toISOString() });
  set(engine, 'organizations/o/sites/s/submissions/3', { delete_at: T0 - 5 });
  set(engine, 'a/4', { expires_at: T0 - 5 });
  set(engine, 'a/5', { delete_at: T0 - 5 });
  set(engine, 'a/5', { delete_at: null });
  expect(engine.nextExpiry()).toBe(T0 - 5);
  expect(engine.removeExpired(T0)).toBe(2);
  expect(engine.get('a/1')).toBeNull();
  expect(engine.get('organizations/o/sites/s/submissions/3')).toBeNull();
  expect(engine.get('a/2')).not.toBeNull();
  expect(engine.get('a/4')).not.toBeNull();
  expect(engine.get('a/5')).not.toBeNull();
  expect(engine.nextExpiry()).toBe(T0 + 60_000);
});

it('adds the TTL column to a database created before it', () => {
  const driver = nodeSqliteDriver();
  driver.exec(`CREATE TABLE documents (path TEXT PRIMARY KEY, parent TEXT NOT NULL, id TEXT NOT NULL,
     data TEXT NOT NULL, revision INTEGER NOT NULL, seq INTEGER NOT NULL)`);
  driver.exec("INSERT INTO documents VALUES ('a/1', 'a', '1', '{\"x\":1}', 1, 1)");
  const engine = new SqlDocumentEngine(driver);
  expect(engine.get('a/1')).toMatchObject({ data: { x: 1 } });
  set(engine, 'a/2', { delete_at: T0 });
  expect(engine.nextExpiry()).toBe(T0);
});

function object(now: () => number) {
  const driver = nodeSqliteDriver();
  const storage: AlarmStorage & { alarm: number | null } = {
    alarm: null,
    sql: { exec: (query, ...params) => { const rows = driver.exec(query, ...params); return { toArray: () => rows }; } },
    transactionSync: work => driver.transaction(work),
    getAlarm: async () => storage.alarm,
    setAlarm: async time => { storage.alarm = time; },
    deleteAlarm: async () => { storage.alarm = null; },
  };
  const rpc = scheduledDocumentStore(storage, { name: 'counters:aa', now, hooks: { deliver: async () => {}, drainOutbox: async () => 0 } });
  let id = 0;
  return { storage, rpc, store: new SqlStore(durableObjectTransport(rpc as never), () => `doc${++id}`) };
}

it('arms the alarm for the first expiry, rounded up to the step, and removes expired documents on it', async () => {
  let now = T0 + 1;
  const { storage, rpc, store } = object(() => now);
  expect(await consumeRateLimit(store, 'auth_rate_limits', 'client-a', 5, 60_000, now)).toMatchObject({ allowed: true });
  expect(storage.alarm).toBe(Math.ceil((T0 + 1 + 60_000) / STEP) * STEP);
  // A later expiry does not move the alarm.
  expect(await consumeRateLimit(store, 'auth_rate_limits', 'client-b', 5, 10 * 60_000, now)).toMatchObject({ allowed: true });
  expect(storage.alarm).toBe(Math.ceil((T0 + 1 + 60_000) / STEP) * STEP);

  now = storage.alarm!;
  await rpc.alarm();
  expect(await store.listDocs('auth_rate_limits')).toHaveLength(0);
  expect(storage.alarm).toBeNull();
  // A limiter whose counter was removed starts a new window.
  expect(await consumeRateLimit(store, 'auth_rate_limits', 'client-a', 1, 60_000, now)).toMatchObject({ allowed: true });
  expect(await consumeRateLimit(store, 'auth_rate_limits', 'client-a', 1, 60_000, now)).toMatchObject({ allowed: false });
});

it('works through a backlog in bounded alarms', async () => {
  let now = T0;
  const { storage, rpc, store } = object(() => now);
  for (let i = 0; i < 5_200; i += 400) {
    await Promise.all(Array.from({ length: 400 }, (_, j) => store.setDoc(`old/${i + j}`, { delete_at: T0 - 1 })));
  }
  await rpc.alarm();
  expect((await store.listDocs('old')).length).toBe(200);
  expect(storage.alarm).toBeLessThanOrEqual(now);
  await rpc.alarm();
  expect(await store.listDocs('old')).toHaveLength(0);
});
