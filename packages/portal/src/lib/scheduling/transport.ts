// Delivery of committed scheduled work. Policy (chains, floors, caps,
// generations, leases) lives in this directory; a transport only delivers.
//
//   durable_object  Cloudflare. Each store object arms its own alarm when a
//                   commit changes its scheduled work, so there is nothing to
//                   send after a commit (store/object-scheduler.ts).
//   local           `npm run dev`: in-process timers deliver due work.
//   off             Tests: nothing is delivered unless the test runs it.
//
// TYPEROLL_SCHEDULER selects it; the default is `local`, and `off` under
// NODE_ENV=test.

import type { IndexWrite } from './index';

export type SchedulingMode = 'durable_object' | 'local' | 'off';

export function schedulingMode(env: NodeJS.ProcessEnv = process.env): SchedulingMode {
  const value = env.TYPEROLL_SCHEDULER?.trim().toLowerCase();
  if (value === 'durable_object' || value === 'local' || value === 'off') return value;
  if (value) throw new Error(`Unsupported TYPEROLL_SCHEDULER: ${value}`);
  return env.NODE_ENV === 'test' ? 'off' : 'local';
}

/** Hand committed work to the transport. The committed index survives a transport failure. */
export async function deliverCommitted(writes: IndexWrite[]): Promise<void> {
  if (schedulingMode() !== 'local') return;
  for (const write of writes) if (write.data) deliverLocally(write.path, write.data.due_at, write.data.generation);
}

// Development only: one timer per work item and generation, retried with backoff.
const LOCAL_RETRY_FLOOR_MS = 1_000;
const LOCAL_RETRY_CEILING_MS = 60_000;
const localTimers = new Map<string, ReturnType<typeof setTimeout>>();

export function deliverLocally(path: string, dueAt: number, generation: string, attempt = 0): void {
  if (dueAt >= Number.MAX_SAFE_INTEGER) return;
  const identity = `${path}:${generation}`;
  if (localTimers.has(identity)) return;
  const timer = setTimeout(async () => {
    localTimers.delete(identity);
    const id = path.split('/').pop()!;
    console.info(JSON.stringify({ event: 'scheduled_delivery', transport: 'local', work: id, attempt, delay_ms: Math.max(0, Date.now() - dueAt) }));
    try {
      const { executeScheduledWork } = await import('./worker');
      await executeScheduledWork(id, generation);
    } catch {
      deliverLocally(path, Date.now() + Math.min(LOCAL_RETRY_CEILING_MS, LOCAL_RETRY_FLOOR_MS * 2 ** attempt), generation, attempt + 1);
    }
  }, Math.min(2_147_483_647, Math.max(0, dueAt - Date.now())));
  timer.unref?.();
  localTimers.set(identity, timer);
}

/** Test-only: cancel pending local deliveries. */
export function _clearLocalDeliveries(): void {
  for (const timer of localTimers.values()) clearTimeout(timer);
  localTimers.clear();
}
