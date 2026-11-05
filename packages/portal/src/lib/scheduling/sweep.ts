// The Cron safety net for Durable Object alarms (every 5 minutes).
//
// Each store object delivers its own due work from its alarm and reports its
// earliest due time to the global `scheduled_objects` index. The sweep reads
// only that index: an object whose reported time passed more than a grace
// period ago is poked, which rebuilds its schedule from its documents and
// re-arms its alarm. No organization, site or object is scanned.

import { getStore, type ReadWriteStore } from '../datastore';
import { SCHEDULED_OBJECTS } from '../store/object-scheduler';

/** A reported time this long past is overdue, not just being delivered. */
export const SWEEP_GRACE_MS = 5 * 60_000;
/** Objects poked per sweep; the rest follow on the next one. */
export const SWEEP_LIMIT = 200;
/** Outbox entries younger than this are left to the writer applying them. */
export const OUTBOX_GRACE_MS = 30_000;

export interface SweepResult { poked: string[]; errors: string[] }

export async function sweepScheduledObjects(poke: (object: string) => Promise<unknown>, opts: { store?: ReadWriteStore; now?: number } = {}): Promise<SweepResult> {
  const store = opts.store ?? getStore(), now = opts.now ?? Date.now(), result: SweepResult = { poked: [], errors: [] };
  const overdue = await store.listDocs<{ object: string; due_at: number }>(SCHEDULED_OBJECTS, {
    filters: [{ field: 'due_at', op: '<=', value: now - SWEEP_GRACE_MS }], limit: SWEEP_LIMIT,
  });
  for (const row of overdue) {
    try { await poke(row.object); result.poked.push(row.object); }
    catch { result.errors.push(row.object); }
  }
  if (overdue.length) console.info(JSON.stringify({ event: 'scheduling_sweep', poked: result.poked.length, errors: result.errors.length }));
  return result;
}

/** The outbox drain a store object's alarm asks for (bound by the Worker). */
export async function drainObjectOutbox(object: string, now = Date.now()): Promise<number> {
  const store = getStore() as ReadWriteStore & { drainOutbox?: (shard: string, opts: { minAgeMs: number; now: number }) => Promise<number> };
  if (typeof store.drainOutbox !== 'function') return 0;
  return store.drainOutbox(object, { minAgeMs: OUTBOX_GRACE_MS, now });
}
