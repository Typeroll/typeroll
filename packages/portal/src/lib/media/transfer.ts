import { createHash, randomUUID } from 'node:crypto';
import type { ReadWriteStore } from '../datastore';

/** Limits cover the complete transfer, including buffered source and verification bytes. */
export class TransferPool {
  private active = 0;
  private bytes = 0;
  private hosts = new Map<string, number>();
  private waiting: Array<() => void> = [];
  private capacity: number;
  private healthy = 0;
  constructor(private maximum = 4, private byteLimit = 200 * 1024 * 1024, private perHost = 2) { this.capacity = maximum; }
  congested() { this.capacity = Math.max(1, Math.floor(this.capacity / 2)); this.healthy = 0; }
  async run<T>(host: string, bytes: number, operation: () => Promise<T>): Promise<T> {
    if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > this.byteLimit) throw Error('media_transfer_budget_exceeded');
    await new Promise<void>(resolve => {
      const acquire = () => {
        if (this.active >= this.capacity || this.bytes + bytes > this.byteLimit || (this.hosts.get(host) ?? 0) >= this.perHost) return false;
        this.active++; this.bytes += bytes; this.hosts.set(host, (this.hosts.get(host) ?? 0) + 1); resolve(); return true;
      };
      const wake = () => { if (!acquire()) this.waiting.push(wake); };
      wake();
    });
    try {
      const result = await operation();
      if (++this.healthy >= 16) { this.capacity = Math.min(this.maximum, this.capacity + 1); this.healthy = 0; }
      return result;
    } finally {
      this.active--; this.bytes -= bytes; this.hosts.set(host, (this.hosts.get(host) ?? 1) - 1);
      for (const wake of this.waiting.splice(0)) wake();
    }
  }
}
export const mediaTransfers = new TransferPool();
export const transferReservation = 50 * 1024 * 1024;
export function retryDelay(value: string | null, attempt: number, now = Date.now()) {
  const seconds = value === null ? NaN : Number(value);
  const requested = Number.isFinite(seconds) ? seconds * 1000 : value ? Date.parse(value) - now : 0;
  return Math.min(30_000, Math.max(250 * 2 ** attempt, Number.isFinite(requested) ? requested : 0));
}
/** Do not retry authorization, missing originals, or integrity failures. */
export async function fetchMedia(url: string, init: RequestInit = {}, fetchImpl = fetch) {
  for (let attempt = 0; ; attempt++) {
    let delay = retryDelay(null, attempt);
    try {
      const response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(30_000) });
      if (response.status !== 429 && response.status < 500 || attempt >= 3) return response;
      delay = retryDelay(response.headers.get('retry-after'), attempt);
      await response.body?.cancel();
    } catch (error) { if (attempt >= 3) throw error; }
    mediaTransfers.congested();
    await new Promise(resolve => setTimeout(resolve, delay + Math.floor(Math.random() * 100)));
  }
}
export interface TransferRecord<T> {
  state: 'queued' | 'running' | 'complete' | 'failed'; lease: string | null; lease_until: number;
  attempts: number; result?: T; error_code?: string | null; updated_at: number;
}
export const transferPath = (scope: string, source: string) => `${scope}/media_transfers/${createHash('sha256').update(source).digest('hex')}`;
/** Durable identity is shared across importer instances; only an expired owner can be replaced. */
export async function durableTransfer<T>(store: ReadWriteStore, scope: string, source: string, operation: () => Promise<T>, valid?: (result: T) => Promise<boolean>): Promise<T> {
  const path = transferPath(scope, source), lease = randomUUID();
  await store.createDocIfMissing(path, { state: 'queued', attempts: 0, lease: null, lease_until: 0, updated_at: Date.now() });
  const deadline = Date.now() + 120_000;
  for (;;) {
    const current = await store.getDoc<TransferRecord<T>>(path);
    if (current?.state === 'complete') {
      if (!valid || await valid(current.result!)) return current.result!;
      await store.compareAndUpdateDoc<TransferRecord<T>>(path, value => value.state === 'complete' && value.updated_at === current.updated_at,
        { state: 'queued', result: null });
      continue;
    }
    if (!current) throw Error('media_transfer_removed');
    const won = await store.compareAndUpdateDoc<TransferRecord<T>>(path, value => value.state !== 'complete' && value.lease_until <= Date.now(),
      { state: 'running', lease, lease_until: Date.now() + 120_000, attempts: current.attempts + 1, error_code: null, updated_at: Date.now() });
    if (!won) {
      if (Date.now() >= deadline) throw Error('media_transfer_busy');
      await new Promise(resolve => setTimeout(resolve, 250)); continue;
    }
    const heartbeat = setInterval(() => { void store.compareAndUpdateDoc<TransferRecord<T>>(path, value => value.lease === lease,
      { lease_until: Date.now() + 120_000 }).catch(() => {}); }, 20_000);
    try {
      const result = await operation();
      if (!await store.compareAndUpdateDoc<TransferRecord<T>>(path, value => value.lease === lease && value.lease_until > Date.now(),
        { state: 'complete', result, lease: null, lease_until: 0, updated_at: Date.now() })) throw Error('media_transfer_lease_lost');
      return result;
    } catch (error) {
      await store.compareAndUpdateDoc<TransferRecord<T>>(path, value => value.lease === lease,
        { state: 'failed', lease: null, lease_until: 0, error_code: 'media_transfer_failed', updated_at: Date.now() });
      throw error;
    } finally { clearInterval(heartbeat); }
  }
}

/** Bound metadata work too, before a transfer acquires its byte reservation. */
export async function mapTransfers<T, R>(items: T[], operation: (item: T) => Promise<R>, concurrency = 4): Promise<R[]> {
  const results = new Array<R>(items.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) { const index = next++; if (index >= items.length) return; results[index] = await operation(items[index]); }
  }));
  return results;
}
