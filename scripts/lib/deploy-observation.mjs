// Observe one deploy job the way the platform's own contract describes it.
//
// A build step that waits in the build provider's queue (Cloudflare Workers
// Builds or GitHub Actions without free capacity in the organization's
// account) is normal: get_deploy_status reports it in build_progress.queue,
// its working time starts only when a runner claims it, and the platform
// fails it with build_queue_timeout at queue.expires_at. An observer that
// counts queue time against a fixed working budget gives up on a healthy
// publication while the account is busy, so queue time has its own bound.

export const DEPLOY_POLL_INTERVAL_MS = 5_000;
/** Working time a publication may take once a runner has claimed its step. */
export const DEFAULT_WORKING_BUDGET_MS = 25 * 60_000;
/** Longest provider-queue wait an unattended check sits through (CI jobs end at 6 h). */
export const DEFAULT_QUEUE_LIMIT_MS = 2 * 60 * 60_000;

const ACTIVE = new Set(['queued', 'running']);

/** The provider-queue state of a status response, or null when no step is waiting for a runner. */
export function providerQueue(status) {
  const queue = status?.build_progress?.queue;
  return queue && typeof queue === 'object' ? queue : null;
}

/**
 * Poll `read()` (one get_deploy_status response: `{ job, build_progress }`)
 * until the job leaves queued/running, and return the final response.
 * Throws when the working budget or the queue limit runs out; the job keeps
 * running on the platform and nothing is retried or replaced here.
 */
export async function observeDeployJob(read, {
  wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  now = Date.now,
  interval = DEPLOY_POLL_INTERVAL_MS,
  workingBudgetMs = DEFAULT_WORKING_BUDGET_MS,
  queueLimitMs = DEFAULT_QUEUE_LIMIT_MS,
  progress = () => {},
} = {}) {
  let working = 0;
  let queued = 0;
  let previous;
  let last = now();
  for (;;) {
    const status = await read();
    const job = status?.job;
    const queue = providerQueue(status);
    const state = `${job?.status}:${job?.phase}`;
    if (state !== previous) { progress(status); previous = state; }
    if (!ACTIVE.has(job?.status)) return status;

    const current = now();
    const elapsed = Math.max(0, current - last);
    last = current;
    if (queue) queued += elapsed; else working += elapsed;

    const id = job?.id ?? 'unknown';
    if (queue) {
      // The platform's own expiry ends the wait; until then the job is healthy.
      const expiresAt = Date.parse(queue.expires_at ?? '');
      if (queued >= queueLimitMs) {
        throw new Error(`Observation stopped: job ${id} is still waiting for ${queue.provider ?? 'the build provider'} to start a runner `
          + `(${queue.message ?? queue.state ?? 'queued'}) after ${Math.round(queued / 60_000)} min in the queue`
          + `${Number.isFinite(expiresAt) ? `; the platform fails it at ${new Date(expiresAt).toISOString()} if no runner starts` : ''}. `
          + 'The build account has no free capacity; the job was left running and nothing was retried.');
      }
    } else if (working >= workingBudgetMs) {
      throw new Error(`Observation stopped: job ${id} is still ${job?.status}${job?.phase ? ` (${job.phase})` : ''} after `
        + `${Math.round(working / 60_000)} min of working time${queued ? ` and ${Math.round(queued / 60_000)} min in the build provider's queue` : ''}. `
        + 'The job was left running and nothing was retried.');
    }
    await wait(interval);
  }
}
