// Liveness and cancellation of workflow runs.
//
// Runs execute as a chain of short chunks delivered by a durable queue
// (engine.ts, queue.ts). When the process executing a chunk goes away — a
// deploy replaces it, an instance is scaled in — the chunk's lease expires and
// the queue's retry resumes it from its saved cursor. The engine records
// `heartbeat_at` while it works. A read that finds a running run without a
// sign of life for WORKFLOW_RESUME_AFTER_MS re-enqueues its current chunk
// under a new id, at most WORKFLOW_MAX_RESUMES times without progress in
// between; only then, or for a run without chunks (started before chunked
// runs, or still pending after WORKFLOW_STALE_AFTER_MS), does it close the run
// as `failed` with failure_code `workflow_interrupted`. Every such write is
// conditional, so a run that is still alive (or completes meanwhile) wins.

import { randomUUID } from 'node:crypto';
import type { WorkflowStatus } from '@typeroll/shared';
import type { ReadWriteStore } from '../datastore';
import type { WorkflowChunkQueue } from './queue';
import type { WorkflowRecord } from './types';

/** How often a live run refreshes heartbeat_at during a long step, at most. */
export const WORKFLOW_HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * How long a run may go without a heartbeat before a read treats it as
 * interrupted. Twenty heartbeat intervals: a live run is never close to it.
 */
export const WORKFLOW_STALE_AFTER_MS = 10 * 60_000;

/**
 * How long a chunked run may go without a sign of life before a read resumes
 * it. A live chunk beats every WORKFLOW_HEARTBEAT_INTERVAL_MS, and the next
 * chunk is delivered within seconds of the previous commit.
 */
export const WORKFLOW_RESUME_AFTER_MS = 3 * 60_000;

/** Resumes without a committed chunk in between before a run is closed as interrupted. */
export const WORKFLOW_MAX_RESUMES = 3;

/** failure_code of a run closed because its process stopped executing it. */
export const WORKFLOW_INTERRUPTED = 'workflow_interrupted';

/** Statuses a person may cancel. Finished runs stay as they ended. */
export const CANCELLABLE_STATUSES: ReadonlySet<WorkflowStatus> = new Set<WorkflowStatus>(['pending', 'running', 'paused_for_review']);

function timeOf(iso: string | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/** The latest moment the run showed it was alive, or null when it never recorded one. */
export function lastSignOfLife(wf: Pick<WorkflowRecord, 'heartbeat_at' | 'started_at' | 'created_at'>): number | null {
  const times = [wf.heartbeat_at, wf.started_at, wf.created_at].map(timeOf).filter((t): t is number => t !== null);
  return times.length ? Math.max(...times) : null;
}

/**
 * True for a run that is `running` (or still `pending`, which the engine
 * leaves within milliseconds) and has shown no sign of life for longer than
 * WORKFLOW_RESUME_AFTER_MS (a chunked run) or WORKFLOW_STALE_AFTER_MS. Runs
 * paused for review wait for a person and are never stale; a run without any
 * timestamp is left alone.
 */
export function isInterrupted(wf: Pick<WorkflowRecord, 'status' | 'heartbeat_at' | 'started_at' | 'created_at' | 'chunk'>, now: number): boolean {
  if (wf.status !== 'running' && wf.status !== 'pending') return false;
  const last = lastSignOfLife(wf);
  const after = wf.status === 'running' && wf.chunk ? WORKFLOW_RESUME_AFTER_MS : WORKFLOW_STALE_AFTER_MS;
  return last !== null && now - last > after;
}

/** An interrupted run that can continue from its saved chunk instead of failing. */
export function isResumable(wf: Pick<WorkflowRecord, 'status' | 'chunk'>): boolean {
  return wf.status === 'running' && !!wf.chunk && (wf.chunk.resumes ?? 0) < WORKFLOW_MAX_RESUMES;
}

function interruptedReason(wf: WorkflowRecord): string {
  if (wf.status === 'running' && wf.chunk) {
    return `This run stopped making progress${wf.current_step ? ` during step ${wf.current_step}` : ''} and could not be resumed after ${wf.chunk.resumes ?? 0} attempt(s), probably because the service kept restarting. It will not continue: start a new run.`;
  }
  const minutes = Math.round(WORKFLOW_STALE_AFTER_MS / 60_000);
  const where = wf.status === 'pending'
    ? 'never started'
    : `stopped making progress${wf.current_step ? ` during step ${wf.current_step}` : ''}`;
  return `This run ${where} and has shown no activity for over ${minutes} minutes, probably because the service restarted. It will not continue: start a new run.`;
}

/** Where to re-enqueue an interrupted run's chunk. */
export interface ResumeTarget {
  queue: WorkflowChunkQueue;
  orgId: string;
}

/**
 * Re-enqueue an interrupted run's current chunk under a new id, so a process
 * that still holds the old one can no longer commit it. Returns the run as it
 * now stands, or null when a concurrent write won.
 */
async function resumeInterruptedRun(store: ReadWriteStore, path: string, wf: WorkflowRecord, now: number, target: ResumeTarget): Promise<WorkflowRecord | null> {
  const chunk = wf.chunk!;
  const attempt = (chunk.resumes ?? 0) + 1;
  const logLength = wf.log?.length ?? 0;
  const update = {
    chunk: { ...chunk, id: randomUUID(), lease_owner: null, lease_until: 0, resumes: attempt },
    heartbeat_at: new Date(now).toISOString(),
    log: [...(wf.log ?? []), `[${wf.current_step ?? 'workflow'}] Interrupted; resuming from saved progress (attempt ${attempt} of ${WORKFLOW_MAX_RESUMES}).`],
  };
  const previous = await store.compareAndUpdateDoc<WorkflowRecord>(
    path,
    (current) => isInterrupted(current, now) && current.chunk?.id === chunk.id && (current.log?.length ?? 0) === logLength,
    update,
  );
  if (!previous) return null;
  try {
    await target.queue.enqueue({ orgId: target.orgId, workflowId: wf.id, chunkId: update.chunk.id });
  } catch (err) {
    // The run is stale again later and the next read retries, or closes it.
    console.warn(`[workflow ${wf.id}] could not re-enqueue after an interruption:`, err);
  }
  return { ...previous, ...update };
}

/**
 * Settle an interrupted run and return the record as it now stands: resume
 * it when it can continue from a saved chunk (and `resume` names the queue),
 * otherwise close it as failed/workflow_interrupted. Both writes are
 * conditional on the stored run still being interrupted with the log we
 * read, so a heartbeat, a step or a completion that lands concurrently wins
 * and is returned instead.
 */
export async function settleInterruptedRun(store: ReadWriteStore, path: string, wf: WorkflowRecord, now: number, resume?: ResumeTarget): Promise<WorkflowRecord> {
  if (!isInterrupted(wf, now)) return wf;
  if (resume && isResumable(wf)) {
    return (await resumeInterruptedRun(store, path, wf, now, resume)) ?? (await store.getDoc<WorkflowRecord>(path)) ?? wf;
  }
  const reason = interruptedReason(wf);
  const logLength = wf.log?.length ?? 0;
  const update = {
    status: 'failed' as const,
    failed_at: new Date(now).toISOString(),
    failure_code: WORKFLOW_INTERRUPTED,
    failure_reason: reason,
    ...(wf.chunk ? { chunk: null } : {}),
    log: [...(wf.log ?? []), `[${wf.current_step ?? 'workflow'}] ERROR: ${reason}`],
  };
  const previous = await store.compareAndUpdateDoc<WorkflowRecord>(
    path,
    (current) => isInterrupted(current, now) && (current.log?.length ?? 0) === logLength,
    update,
  );
  if (previous) return { ...previous, ...update };
  return (await store.getDoc<WorkflowRecord>(path)) ?? wf;
}

/**
 * Cancel a run that has not finished. Returns the cancelled record, or null
 * when the stored run is already completed, failed or cancelled. The engine
 * sees the status at its next write and stops without recording more; no
 * further chunk runs.
 */
export async function cancelRun(store: ReadWriteStore, path: string, cancelledBy: string, now: number): Promise<WorkflowRecord | null> {
  const update = {
    status: 'cancelled' as const,
    cancelled_at: new Date(now).toISOString(),
    cancelled_by: cancelledBy,
  };
  const previous = await store.compareAndUpdateDoc<WorkflowRecord>(path, (current) => CANCELLABLE_STATUSES.has(current.status), update);
  if (!previous) return null;
  const log = [...(previous.log ?? []), `[${previous.current_step ?? 'workflow'}] cancelled by ${cancelledBy}`];
  // The log append is best-effort: the status above is what stops the run.
  await store.updateDoc(path, { log }).catch(() => {});
  return { ...previous, ...update, log };
}
