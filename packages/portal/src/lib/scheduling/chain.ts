// Single-flight delivery chains.
//
// Some background work polls: it runs, then asks to run again later. Each
// caller that wants the work started used to add its own chain of deliveries,
// so a busy period could leave dozens of chains polling the same work every
// ten seconds. A chain record makes every request for the same key join the
// one chain: a request while it runs marks it to run again, a request while a
// delivery is pending keeps the earlier time, and a delivery from a replaced
// generation is dropped. The record lives in the store, so the rule holds for
// every transport (store-object alarms, local timers).

import { createHash } from 'node:crypto';
import { getStore } from '../datastore';

/** Minimum gap between two deliveries of one chain. */
export const CHAIN_FLOOR_MS = 5_000;
/** A delivery that runs longer than this is presumed lost; the chain may restart. */
export const CHAIN_LEASE_MS = 5 * 60_000;

interface ChainRecord { key: string; generation: number; due_at: number | null; lease_until: number; rerun: boolean; deliveries: number; updated_at: number }
export type Enqueue = (generation: number, delayMs: number) => Promise<void>;

const chainPath = (key: string) => `scheduling_chains/${createHash('sha256').update(key).digest('hex')}`;
const fresh = (key: string, now: number): ChainRecord => ({ key, generation: 0, due_at: null, lease_until: 0, rerun: false, deliveries: 0, updated_at: now });

async function update(key: string, decide: (record: ChainRecord) => ChainRecord | null): Promise<ChainRecord | null> {
  const store = getStore(), path = chainPath(key);
  for (let attempt = 0; attempt < 20; attempt++) {
    const current = await store.getDoc<ChainRecord>(path);
    const base = current ? (({ id: _id, ...rest }) => rest)(current as ChainRecord & { id: string }) as ChainRecord : fresh(key, Date.now());
    const next = decide(structuredClone(base));
    if (!next) return null;
    if (await store.compareAndReplaceDoc(path, current, next)) return next;
  }
  throw new Error(`Scheduling chain ${key} is contended; retry`);
}

/** Ask for the chain to run within `delayMs`; joins an existing chain instead of adding one. */
export async function requestChain(key: string, delayMs: number, enqueue: Enqueue, now = Date.now()): Promise<'scheduled' | 'joined'> {
  const due = now + Math.max(0, delayMs);
  const record = await update(key, record => {
    if (record.lease_until > now) return record.rerun ? null : { ...record, rerun: true, updated_at: now };
    // A pending delivery at or before the requested time covers this request,
    // unless it is overdue by more than a lease: then it was lost, so restart.
    if (record.due_at !== null && record.due_at <= due && record.due_at > now - CHAIN_LEASE_MS) return null;
    return { ...record, generation: record.generation + 1, due_at: due, updated_at: now };
  });
  if (!record || record.lease_until > now) return 'joined';
  await enqueue(record.generation, due - now);
  return 'scheduled';
}

/**
 * Run one delivery of a chain. `work` returns the delay before it needs to run
 * again, or null when it is done. A delivery from a superseded generation, or
 * while another delivery holds the lease, does nothing.
 */
export async function runChainDelivery(key: string, generation: number, work: () => Promise<number | null>, enqueue: Enqueue, now = () => Date.now()): Promise<'ran' | 'superseded'> {
  const started = now();
  // Only the pending delivery of the current generation runs; a repeat after it ran is dropped.
  const claimed = await update(key, record => record.generation !== generation || record.due_at === null || record.lease_until > started ? null
    : { ...record, due_at: null, lease_until: started + CHAIN_LEASE_MS, rerun: false, deliveries: record.deliveries + 1, updated_at: started });
  if (!claimed) return 'superseded';
  console.info(JSON.stringify({ event: 'scheduled_delivery', chain: key, generation, deliveries: claimed.deliveries }));
  let delay: number | null;
  try { delay = await work(); }
  catch (error) {
    // Release the lease and leave it pending so the transport's retry of this delivery can claim it again.
    await update(key, record => record.generation === generation ? { ...record, lease_until: 0, due_at: now(), updated_at: now() } : null);
    throw error;
  }
  const finished = now();
  const next = await update(key, record => {
    if (record.generation !== generation) return null;
    const again = delay !== null || record.rerun;
    if (!again) return { ...record, lease_until: 0, rerun: false, due_at: null, updated_at: finished };
    const wait = Math.max(CHAIN_FLOOR_MS, delay ?? 0);
    return { ...record, lease_until: 0, rerun: false, generation: record.generation + 1, due_at: finished + wait, updated_at: finished };
  });
  if (next?.due_at !== null && next?.due_at !== undefined) {
    try { await enqueue(next.generation, next.due_at - finished); }
    catch (error) {
      // Not scheduled after all: clear the pending time so the next request restarts the chain.
      await update(key, record => record.generation === next.generation ? { ...record, due_at: null, updated_at: now() } : null);
      throw error;
    }
  }
  return 'ran';
}
