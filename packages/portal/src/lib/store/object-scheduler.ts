// Scheduled work inside one store Durable Object (a site, an organization or
// the global object).
//
// The object's own `scheduled_work` documents are the durable source of truth.
// After every commit that touches them, a small mirror table is refreshed in
// the same transaction, and the object's single alarm is set to the earliest
// due item (setAlarm replaces, so each object has one pending alarm). The
// alarm drains the object's outbox, then hands each due item to the portal's
// executor through `hooks.deliver`; generation and lease checks there make a
// late or repeated delivery harmless. A failed or unconsumed delivery backs
// off in the mirror only, never in the durable document.
//
// The same alarm is the store's TTL: a document with a past `delete_at` is
// removed on the next alarm, which is set for the earliest expiry rounded up
// to a step (15 minutes), so no Cron job has to look for expired records.
//
// Each object also reports its earliest due time to the global
// `scheduled_objects` index (through its own outbox), so a Cron sweep can poke
// objects whose alarm was lost without scanning every object.

import { documentStoreMethods, type DocumentStoreHousekeeping, type DocumentStoreRpc, type DurableSqlStorage } from './durable-object';
import type { CommitResult, Precondition, Write } from './sql-engine';

export const SCHEDULED_WORK = 'scheduled_work';
/** Global index: one row per object with pending work, id = object name. */
export const SCHEDULED_OBJECTS = 'scheduled_objects';
const OUTBOX = '_outbox';
/** The object's single, replaced-in-place report to the global index. */
export const REPORT_ENTRY = `${OUTBOX}/scheduling`;
/** due_at of finished or parked work. */
const NEVER = Number.MAX_SAFE_INTEGER;

export interface ScheduledDelivery { object: string; id: string; kind: string; generation: string; due_at: number; attempt: number }

/** Bound by the Worker: both run in a Worker invocation of their own, not in the object. */
export interface ObjectSchedulerHooks {
  /** Execute one due item. Throwing (or leaving it due) retries it with backoff. */
  deliver(delivery: ScheduledDelivery): Promise<void>;
  /** Apply this object's outbox entries to their target objects. */
  drainOutbox(object: string): Promise<unknown>;
}

export interface AlarmStorage extends DurableSqlStorage {
  getAlarm(): Promise<number | null>;
  setAlarm(time: number): Promise<void>;
  deleteAlarm(): Promise<void>;
}

export interface ObjectSchedulerOptions {
  /** This object's store name (`site:<uid>`, `org:<id>`, `global`): `ctx.id.name`. */
  name: string;
  hooks: ObjectSchedulerHooks;
  now?: () => number;
  /** First retry delay of a failed delivery; doubles up to the ceiling. */
  retryFloorMs?: number;
  retryCeilingMs?: number;
  /** Outbox entries younger than this are left to the writer that is applying them. */
  outboxGraceMs?: number;
  /** Due items delivered per alarm; the rest follow on the next alarm. */
  batch?: number;
  /** A later due time is reported only when it moved by more than this. */
  reportSlackMs?: number;
  /** Expired documents (`delete_at`) are removed on alarms rounded up to this step, so a busy object is not woken per expiry. */
  ttlStepMs?: number;
}

type Row = { path: string; kind: string; generation: string; due_at: number; ready_at: number; attempts: number; retry_at: number };

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS scheduling_due (path TEXT PRIMARY KEY, kind TEXT NOT NULL, generation TEXT NOT NULL,
     due_at INTEGER NOT NULL, ready_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, retry_at INTEGER NOT NULL DEFAULT 0)`,
  'CREATE TABLE IF NOT EXISTS scheduling_meta (key TEXT PRIMARY KEY, value INTEGER)',
];
const parentOf = (path: string) => path.slice(0, path.lastIndexOf('/'));

export class ObjectScheduler {
  private readonly now: () => number;
  private readonly floor: number;
  private readonly ceiling: number;
  private readonly grace: number;
  private readonly batch: number;
  private readonly slack: number;
  private readonly ttlStep: number;
  /** The alarm this instance last set; undefined when unknown (new instance, alarm fired). */
  private armed: number | null | undefined;

  constructor(private readonly storage: AlarmStorage, private readonly store: DocumentStoreRpc, private readonly options: ObjectSchedulerOptions,
    private readonly ttl?: DocumentStoreHousekeeping) {
    for (const statement of SCHEMA) storage.sql.exec(statement);
    this.now = options.now ?? Date.now;
    this.floor = options.retryFloorMs ?? 5_000;
    this.ceiling = options.retryCeilingMs ?? 10 * 60_000;
    this.grace = options.outboxGraceMs ?? 30_000;
    this.batch = options.batch ?? 25;
    this.slack = options.reportSlackMs ?? 10 * 60_000;
    this.ttlStep = options.ttlStepMs ?? 15 * 60_000;
  }

  /** When the next expired document should be removed, rounded up to the TTL step. */
  private expiryDue(): number | null {
    const next = this.ttl?.nextExpiry() ?? null;
    return next === null ? null : Math.ceil(next / this.ttlStep) * this.ttlStep;
  }

  /** True when a commit added an expiry earlier than the alarm that is set. */
  expiryNeedsAlarm(): boolean {
    const due = this.expiryDue();
    return due !== null && (this.armed == null || due < this.armed);
  }

  /** Remove expired documents in bounded batches; what is left re-arms the alarm at once. */
  private removeExpired(now: number) {
    if (!this.ttl) return;
    let removed = 0;
    for (let batch = 0; batch < 10; batch++) {
      const count = this.ttl.removeExpired(now, 500);
      removed += count;
      if (count < 500) break;
    }
    if (removed) console.info(JSON.stringify({ event: 'expired_documents_removed', object: this.options.name, removed }));
  }

  private exec<T>(sql: string, ...params: unknown[]): T[] { return this.storage.sql.exec(sql, ...params).toArray() as T[]; }

  /** Mirror written scheduled work (synchronous: call inside the commit's transaction). True when the alarm may change. */
  refresh(paths: string[]): boolean {
    let touched = false;
    for (const path of new Set(paths)) {
      const parent = parentOf(path);
      if (parent === OUTBOX) touched = true;
      if (parent !== SCHEDULED_WORK) continue;
      touched = true;
      this.mirror(path, this.store.get(path)?.data ?? null);
    }
    return touched;
  }

  private mirror(path: string, work: Record<string, any> | null) {
    const due = work?.due_at;
    if (typeof due !== 'number' || !Number.isFinite(due) || due >= NEVER || typeof work?.generation !== 'string') {
      this.exec('DELETE FROM scheduling_due WHERE path = ?', path);
      return;
    }
    const ready = Math.max(due, typeof work.lease_until === 'number' ? work.lease_until : 0);
    const kind = typeof work.kind === 'string' ? work.kind : 'unknown';
    // A new generation is a new delivery: its retry state starts over.
    this.exec(`INSERT INTO scheduling_due (path, kind, generation, due_at, ready_at, attempts, retry_at) VALUES (?, ?, ?, ?, ?, 0, 0)
      ON CONFLICT(path) DO UPDATE SET kind = excluded.kind, due_at = excluded.due_at, ready_at = excluded.ready_at,
        attempts = CASE WHEN generation = excluded.generation THEN attempts ELSE 0 END,
        retry_at = CASE WHEN generation = excluded.generation THEN retry_at ELSE 0 END,
        generation = excluded.generation`, path, kind, work.generation, due, ready);
  }

  /** Rebuild the mirror from the documents (after a lost refresh, or a tree delete). */
  rebuild(): void {
    this.storage.transactionSync(() => {
      this.exec('DELETE FROM scheduling_due');
      for (const doc of this.store.list(SCHEDULED_WORK)) this.mirror(doc.path, doc.data);
    });
  }

  /** Earliest time a mirrored item may be delivered. */
  nextDue(): number | null {
    return this.exec<{ t: number | null }>('SELECT MIN(MAX(ready_at, retry_at)) AS t FROM scheduling_due')[0]?.t ?? null;
  }

  private outboxDue(): number | null {
    const created = this.store.list(OUTBOX).map(doc => Number(doc.data.created_at)).filter(Number.isFinite);
    return created.length ? Math.min(...created) + this.grace : null;
  }

  private meta(key: string): number | null {
    return this.exec<{ value: number | null }>('SELECT value FROM scheduling_meta WHERE key = ?', key)[0]?.value ?? null;
  }

  /** Keep the global index row of this object close to its earliest due time. */
  private report(next: number | null, exact: boolean) {
    const reported = this.meta('reported_due');
    const changed = next !== reported;
    const needed = exact ? changed
      : next === null ? reported !== null
        : reported === null || next < reported || next > reported + this.slack;
    if (!needed) return;
    const name = this.options.name;
    this.storage.transactionSync(() => {
      this.store.commit([], [{ path: REPORT_ENTRY, op: 'set', data: {
        writes: [{ shard: 'global', path: `${SCHEDULED_OBJECTS}/${name}`, data: next === null ? null : { object: name, due_at: next } }],
        created_at: this.now(),
      } }]);
      this.exec("INSERT INTO scheduling_meta (key, value) VALUES ('reported_due', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", next);
    });
  }

  /** Set the object's alarm to its earliest due item, outbox entry or expiry; clear it when there is none. */
  async arm(exact = false): Promise<number | null> {
    this.report(this.nextDue(), exact);
    const candidates = [this.nextDue(), this.outboxDue(), this.expiryDue()].filter((value): value is number => value !== null);
    const at = candidates.length ? Math.min(...candidates) : null;
    if (at === this.armed) return at;
    if (at === null) await this.storage.deleteAlarm();
    else await this.storage.setAlarm(at);
    this.armed = at;
    return at;
  }

  /** The alarm handler: drain the outbox, deliver due work, re-arm. Never throws for a failed delivery. */
  async alarm(): Promise<void> {
    this.armed = undefined;
    const now = this.now();
    const stale = this.outboxDue();
    if (stale !== null && stale <= now) {
      try { await this.options.hooks.drainOutbox(this.options.name); }
      catch { console.error(JSON.stringify({ event: 'outbox_drain_failed', object: this.options.name })); }
    }
    this.removeExpired(now);
    const due = this.exec<Row>(`SELECT * FROM scheduling_due WHERE MAX(ready_at, retry_at) <= ?
      ORDER BY kind = 'page_schedule' DESC, due_at LIMIT ?`, now, this.batch);
    // Page transitions first: they create the site publications that follow them.
    for (const row of due.filter(row => row.kind === 'page_schedule')) await this.deliver(row, now);
    await Promise.all(due.filter(row => row.kind !== 'page_schedule').map(row => this.deliver(row, now)));
    await this.arm();
  }

  private async deliver(row: Row, now: number) {
    const id = row.path.slice(row.path.lastIndexOf('/') + 1);
    console.info(JSON.stringify({ event: 'scheduled_delivery', object: this.options.name, kind: row.kind, work: id, attempt: row.attempts, delay_ms: Math.max(0, now - row.due_at) }));
    let failed = false;
    try { await this.options.hooks.deliver({ object: this.options.name, id, kind: row.kind, generation: row.generation, due_at: row.due_at, attempt: row.attempts }); }
    catch { failed = true; }
    // Still due with the same generation: failed, or not consumed. Back off so it cannot spin.
    const after = this.exec<Row>('SELECT * FROM scheduling_due WHERE path = ?', row.path)[0];
    const finished = this.now();
    if (after && after.generation === row.generation && Math.max(after.ready_at, after.retry_at) <= finished) {
      const wait = Math.min(this.ceiling, this.floor * 2 ** Math.min(after.attempts, 20));
      this.exec('UPDATE scheduling_due SET attempts = attempts + 1, retry_at = ? WHERE path = ? AND generation = ?', finished + wait, row.path, row.generation);
    }
    if (failed) console.warn(JSON.stringify({ event: 'scheduled_delivery_retry', object: this.options.name, kind: row.kind, work: id, attempt: row.attempts + 1 }));
  }

  /** The Cron sweep's poke: rebuild from the documents, report exactly, re-arm. */
  async wake(): Promise<number | null> {
    this.rebuild();
    this.armed = undefined;
    return this.arm(true);
  }
}

/** The document store methods of an object whose commits keep its alarm current. */
export interface ScheduledDocumentStore extends Omit<DocumentStoreRpc, 'commit' | 'deleteTree'> {
  commit(preconditions: Precondition[], writes: Write[]): Promise<CommitResult>;
  deleteTree(path: string): Promise<number>;
  alarm(): Promise<void>;
  wake(): Promise<number | null>;
}

/** For the store object class: engine methods plus `alarm()` and `wake()`. */
export function scheduledDocumentStore(storage: AlarmStorage, options: ObjectSchedulerOptions): ScheduledDocumentStore {
  const { nextExpiry, removeExpired, ...store } = documentStoreMethods(storage);
  const scheduler = new ObjectScheduler(storage, store, options, { nextExpiry, removeExpired });
  return {
    ...store,
    async commit(preconditions, writes) {
      // The mirror commits with the documents: a crash cannot separate them.
      let touched = false;
      const result = storage.transactionSync(() => {
        const committed = store.commit(preconditions, writes);
        if (committed.ok) touched = scheduler.refresh(writes.map(write => write.path));
        return committed;
      });
      if (touched || (result.ok && scheduler.expiryNeedsAlarm())) await scheduler.arm();
      return result;
    },
    async deleteTree(path) {
      const removed = store.deleteTree(path);
      if (removed) { scheduler.rebuild(); await scheduler.arm(); }
      return removed;
    },
    alarm: () => scheduler.alarm(),
    wake: () => scheduler.wake(),
  };
}
