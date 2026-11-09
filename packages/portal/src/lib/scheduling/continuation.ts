import { randomUUID } from 'node:crypto';
import { ConnectionError } from '../publishing/connections';
import { getStore } from '../datastore';
import { buildTasksPath, type BuildTask } from '../builds/queue';
import { readBuildQueue } from '../builds/queue-state';

export interface Continuation { token: string; reason: string; due_at: number | null; attempt: number;
  /** Consecutive condition polls since the publication last made progress, across phase names. */
  polls?: number }

/** Poll intervals for conditions without a completion event; never shorter after a phase rename. */
export const POLL_DELAYS_MS = [1000, 2000, 4000, 8000, 15000, 30000];
/** A publication that polls this often without progress is stuck in a loop, not waiting. */
export const MAX_POLLS_WITHOUT_PROGRESS = 2000;

export async function schedulePublication(path: string, reason: string, delayMs = 0, poll = false): Promise<'waiting'> {
  const store = getStore(), job = await store.getDoc<any>(path);
  if (!job || !['queued', 'running'].includes(job.status)) return 'waiting';
  const attempt = job.continuation?.reason === reason ? job.continuation.attempt + 1 : 0;
  // Only progress (a checkpoint, a completion) resets the poll count; a new phase name does not.
  const polls = poll ? (job.continuation?.polls ?? 0) + 1 : 0;
  if (polls > MAX_POLLS_WITHOUT_PROGRESS) {
    console.info(JSON.stringify({ event: 'continuation_budget_exceeded', path, reason, polls }));
    throw new ConnectionError(`Publication verification polled ${MAX_POLLS_WITHOUT_PROGRESS} times without progress (last: ${reason}). The live site is unchanged; retry verification or publish again.`, 409, 'continuation_budget_exceeded');
  }
  const saved = await store.compareAndReplaceDoc(path, job, { ...job, continuation: { token: randomUUID(), reason, due_at: Date.now() + delayMs, attempt, polls } satisfies Continuation });
  if (!saved) throw Object.assign(new Error('Concurrent publication update; retry this delivery'), { code: 10 });
  return 'waiting';
}

/** How often a publication rechecks its own queued step: soon after dispatch, then every minute. */
export const QUEUED_BUILD_POLL_MS = { first: 15_000, steady: 60_000, settle_seconds: 120 };

/** The job's phase while its step is queued, and the working phase to restore once a runner claims it. */
export interface BuildWait { key: string; phase: string; resume_phase: string | null }

/**
 * Completion is the only automatic trigger for a running build. A queued
 * step is rechecked on a bounded schedule by this publication only: each
 * recheck reads the step's own provider dispatch (and starts it again when the
 * provider stopped it unclaimed) and says in the phase why it has not started.
 * The schedule ends when a runner claims the step, it fails, or it reaches the
 * queue cap.
 */
export async function waitForBuild(path: string, org: string, key: string): Promise<'waiting'> {
  const store = getStore();
  // Read the job before the task. CAS prevents a callback arriving between
  // these reads and the save from being overwritten by a waiting state.
  for (let attempt = 0; attempt < 5; attempt++) {
    const job = await store.getDoc<any>(path);
    if (!job || !['queued', 'running'].includes(job.status)) return 'waiting';
    const task = await store.getDoc<BuildTask>(`${buildTasksPath(org)}/${key}`);
    const complete = task && ['completed', 'failed', 'cancelled'].includes(task.status);
    const queue = task?.status === 'queued' ? await readBuildQueue(org, key) : null;
    const wait: BuildWait | null = job.build_wait ?? null;
    const showingQueue = wait && job.phase === wait.phase;
    let phase = job.phase, buildWait: BuildWait | null = null;
    if (queue) {
      phase = queue.message;
      buildWait = { key, phase: queue.message, resume_phase: showingQueue ? wait.resume_phase : job.phase ?? null };
    } else if (showingQueue && wait.resume_phase) phase = wait.resume_phase;
    const delay = queue ? (queue.queued_for_seconds < QUEUED_BUILD_POLL_MS.settle_seconds ? QUEUED_BUILD_POLL_MS.first : QUEUED_BUILD_POLL_MS.steady) : null;
    if (await store.compareAndReplaceDoc(path, job, { ...job, phase, build_wait: buildWait, continuation: {
      token: randomUUID(), reason: complete ? 'build_result' : `build:${key}`,
      due_at: complete ? Date.now() : delay === null ? null : Date.now() + delay, attempt: 0,
    } satisfies Continuation })) return 'waiting';
  }
  throw Object.assign(new Error('Concurrent publication update; retry this delivery'), { code: 10 });
}

/** Only visibility/transport conditions without completion events use bounded backoff. */
export async function waitForPublicationCondition(path: string, reason: string): Promise<'waiting'> {
  const job = await getStore().getDoc<any>(path);
  // Backoff follows consecutive polls, so alternating phase names cannot hold it at one second.
  const polls = job?.continuation?.polls ?? 0;
  return schedulePublication(path, reason, POLL_DELAYS_MS[Math.min(polls, POLL_DELAYS_MS.length - 1)]!, true);
}
