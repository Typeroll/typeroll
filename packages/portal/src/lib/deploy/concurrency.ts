// How many builds one process may run at once.
//
// A build is CPU-bound (`astro build` is a child process pegging a core) and
// the deploy worker is a route on the SAME service that serves the portal, at
// `--cpu=1 --concurrency=50`. So two builds landing on one instance don't run
// twice as fast — they halve each other while also starving every user request
// routed to that instance.
//
// **Default 1, and that default is right in both deployments.** A self-hosted
// install on a single box must never run two builds at once, and a Cloud Run
// instance has exactly one vCPU, so a second concurrent build there is equally
// pointless. Platform-wide parallelism comes from having several instances
// (Cloud Tasks dispatches up to `--max-concurrent-dispatches`, Cloud Run
// spreads them), not from packing builds onto one.
//
// This is a per-PROCESS gate, deliberately. A cross-instance limit would need
// either a distributed lease — which the fixtures backend has no transactions
// for — or a scheduler. Cloud Tasks already provides the cross-instance cap;
// this closes the gap it leaves, which is that nothing stops several of its
// concurrent dispatches from landing on the same instance.

/** Env-overridable so an operator with a bigger instance can raise it. */
export function maxConcurrentBuilds(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.DEPLOY_MAX_CONCURRENT);
  if (!Number.isFinite(raw) || raw < 1) return 1;
  return Math.floor(raw);
}

/**
 * How long the Cloud Tasks worker waits for a slot before handing the task
 * back. Well under Cloud Run's 900 s request limit, so a waiting worker never
 * dies holding a slot it was about to get.
 */
export function slotWaitMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.DEPLOY_SLOT_WAIT_MS);
  if (!Number.isFinite(raw) || raw < 0) return 4 * 60 * 1000;
  return Math.floor(raw);
}

export interface BuildSlot {
  release(): void;
}

let active = 0;
/** FIFO, so a build that has been waiting is served before a fresh arrival.
 *  LIFO would let a busy platform starve whichever deploy waited longest. */
const waiting: Array<(slot: BuildSlot | null) => void> = [];

function makeSlot(): BuildSlot {
  active++;
  let released = false;
  return {
    release() {
      // Idempotent: the callers release in a `finally`, and a double release
      // would hand out a slot that isn't free.
      if (released) return;
      released = true;
      active--;
      const next = waiting.shift();
      // Hand the slot straight to the next waiter rather than letting it
      // re-check, so a fresh arrival can't slip in ahead of it. makeSlot()
      // re-increments `active`, which is the transfer: one slot out, one in.
      if (next) next(makeSlot());
    },
  };
}

/**
 * Take a build slot, waiting up to `waitMs`. Resolves null when the wait runs
 * out — the caller decides whether that means "hand the task back" (Cloud
 * Tasks will redeliver) or "keep waiting".
 *
 * `Infinity` is the right budget for the in-process backend: it is
 * fire-and-forget with no redelivery, so giving up would silently drop a
 * deploy the user asked for.
 */
export function acquireBuildSlot(waitMs: number = Infinity): Promise<BuildSlot | null> {
  if (active < maxConcurrentBuilds()) return Promise.resolve(makeSlot());
  if (waitMs <= 0) return Promise.resolve(null);

  return new Promise<BuildSlot | null>((resolve) => {
    let settled = false;
    const timer = waitMs === Infinity ? null : setTimeout(() => {
      if (settled) return;
      settled = true;
      const i = waiting.indexOf(waiter);
      if (i >= 0) waiting.splice(i, 1);
      resolve(null);
    }, waitMs);

    const waiter = (slot: BuildSlot | null): void => {
      if (settled) {
        // Timed out a tick before the slot arrived — give it straight back so
        // it isn't leaked for the lifetime of the process.
        slot?.release();
        return;
      }
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(slot);
    };
    waiting.push(waiter);
  });
}

/** Observability: what the gate currently holds. */
export function buildSlotStats(): { active: number; waiting: number; max: number } {
  return { active, waiting: waiting.length, max: maxConcurrentBuilds() };
}

/** Tests only. */
export function _resetBuildSlotsForTests(): void {
  active = 0;
  waiting.length = 0;
}
