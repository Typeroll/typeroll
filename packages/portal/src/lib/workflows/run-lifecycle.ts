// Liveness and cancellation of workflow runs.
//
// Runs execute inline in the portal process that started them (engine.ts).
// When that process goes away mid-run — a deploy replaces it, an instance is
// scaled in — the run keeps status `running` and nothing will ever finish it.
// The engine records `heartbeat_at` while it works; a read that finds a run
// without a sign of life for WORKFLOW_STALE_AFTER_MS closes it as `failed`
// with failure_code `workflow_interrupted`, once, with a conditional write so
// a run that is still alive (or completes meanwhile) wins.

import type { WorkflowStatus } from '@typeroll/shared';
import type { ReadWriteStore } from '../datastore';
import type { WorkflowRecord } from './types';

/** How often a live run refreshes heartbeat_at during a long step, at most. */
export const WORKFLOW_HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * How long a run may go without a heartbeat before a read treats it as
 * interrupted. Twenty heartbeat intervals: a live run is never close to it.
 */
export const WORKFLOW_STALE_AFTER_MS = 10 * 60_000;

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
 * WORKFLOW_STALE_AFTER_MS. Runs paused for review wait for a person and are
 * never stale; a run without any timestamp is left alone.
 */
export function isInterrupted(wf: Pick<WorkflowRecord, 'status' | 'heartbeat_at' | 'started_at' | 'created_at'>, now: number): boolean {
  if (wf.status !== 'running' && wf.status !== 'pending') return false;
  const last = lastSignOfLife(wf);
  return last !== null && now - last > WORKFLOW_STALE_AFTER_MS;
}

function interruptedReason(wf: WorkflowRecord): string {
  const minutes = Math.round(WORKFLOW_STALE_AFTER_MS / 60_000);
  const where = wf.status === 'pending'
    ? 'never started'
    : `stopped making progress${wf.current_step ? ` during step ${wf.current_step}` : ''}`;
  return `This run ${where} and has shown no activity for over ${minutes} minutes, probably because the service restarted. It will not continue: start a new run.`;
}

/**
 * Close the run as failed/workflow_interrupted when it is interrupted, and
 * return the record as it now stands. The write is conditional on the stored
 * run still being interrupted with the log we read, so a heartbeat, a step
 * or a completion that lands concurrently wins and is returned instead.
 */
export async function settleInterruptedRun(store: ReadWriteStore, path: string, wf: WorkflowRecord, now: number): Promise<WorkflowRecord> {
  if (!isInterrupted(wf, now)) return wf;
  const reason = interruptedReason(wf);
  const logLength = wf.log?.length ?? 0;
  const update = {
    status: 'failed' as const,
    failed_at: new Date(now).toISOString(),
    failure_code: WORKFLOW_INTERRUPTED,
    failure_reason: reason,
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
 * sees the status at its next write and stops without recording more.
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
