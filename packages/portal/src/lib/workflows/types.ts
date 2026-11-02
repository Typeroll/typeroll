// Workflow engine types.
//
// A workflow is an ordered list of steps. Each step receives the workflow's
// accumulated state and returns updates to it. Steps can pause the workflow
// to wait for human review. A step that works through many items (URLs,
// links, pages) can also yield: it returns `stepYield(cursor)` with its
// progress, and the engine persists the cursor and runs the step again in the
// next chunk, possibly in another process, with `ctx.cursor` set.

import type { WorkflowType, WorkflowStatus } from '@typeroll/shared';
import type { ReadWriteStore } from '../datastore';

export interface WorkflowContext {
  orgId: string;
  siteId: string;
  workflowId: string;
  config: Record<string, unknown>;
  state: Record<string, unknown>;
  store: ReadWriteStore;
  log(msg: string): void;
  /** Also refreshes the run's heartbeat, at most every WORKFLOW_HEARTBEAT_INTERVAL_MS. */
  setProgress(progress: WorkflowProgress): void;
  /**
   * Record a sign of life without changing progress (throttled like
   * setProgress). The engine already beats on a timer while a step runs; a
   * step may call this from its own long loops.
   */
  heartbeat?(): void;
  /**
   * The cursor this step returned with stepYield in the previous chunk, or
   * undefined when the step starts. Plain JSON.
   */
  cursor?: unknown;
  /**
   * True once this chunk has spent its time budget, or the run was cancelled
   * or taken over meanwhile. A resumable step then finishes the items in
   * flight and returns stepYield(cursor). Steps that never yield ignore it;
   * absent when a step is called outside the engine (it then never yields
   * for time).
   */
  shouldYield?(): boolean;
}

export interface WorkflowProgress {
  total: number;
  completed: number;
  review?: number;
  error?: number;
}

export interface ReviewGate {
  __review: true;
  message: string;
  data?: Record<string, unknown>;
}

/** A resumable step's request to continue in the next chunk from `cursor`. */
export interface StepYield {
  __yield: true;
  cursor: unknown;
}

export type StepResult =
  | { state?: Record<string, unknown>; results?: Record<string, unknown> }
  | ReviewGate
  | StepYield;

export interface WorkflowStep {
  name: string;
  label: string;
  /** When true, the step pauses the workflow for human review on success. */
  needsReview?: boolean;
  run(ctx: WorkflowContext): Promise<StepResult>;
}

export interface WorkflowDef {
  type: WorkflowType;
  label: string;
  description: string;
  steps: WorkflowStep[];
}

export function reviewGate(message: string, data?: Record<string, unknown>): ReviewGate {
  return { __review: true, message, data: data ?? {} };
}

export function isReviewGate(v: unknown): v is ReviewGate {
  return typeof v === 'object' && v !== null && (v as { __review?: boolean }).__review === true;
}

/** Continue this step in the next chunk; `cursor` must be plain JSON. */
export function stepYield(cursor: unknown): StepYield {
  return { __yield: true, cursor };
}

export function isStepYield(v: unknown): v is StepYield {
  return typeof v === 'object' && v !== null && (v as { __yield?: boolean }).__yield === true;
}

/**
 * The run's next unit of work. Every chunk is delivered with its `id`; the
 * engine runs it only while the stored run still names that id, and commits
 * its result with a compare-and-update on {id, step_index, cursor} that also
 * replaces the id. A duplicate or late delivery therefore finds another id
 * and does nothing. Internal: never part of the run summary.
 */
export interface WorkflowChunk {
  id: string;
  step_index: number;
  /** JSON of the step's cursor, or null when the step starts. */
  cursor: string | null;
  /** The process executing this chunk, while it holds the lease. */
  lease_owner: string | null;
  /** Epoch ms until which the lease holds; 0 when the chunk is not executing. */
  lease_until: number;
  /** Times the run was re-enqueued after an interruption since its last committed chunk. */
  resumes: number;
  /** Chunks committed so far. */
  seq: number;
}

export interface WorkflowRecord {
  id: string;
  site_id: string;
  type: WorkflowType;
  status: WorkflowStatus;
  config: Record<string, unknown>;
  state?: Record<string, unknown>;
  results?: Record<string, unknown>;
  current_step?: string;
  step_index?: number;
  progress?: WorkflowProgress;
  log?: string[];
  review_message?: string;
  review_data?: Record<string, unknown>;
  created_at?: string;
  started_at?: string;
  /**
   * Last sign of life from the process executing the run: every state write,
   * and at most every WORKFLOW_HEARTBEAT_INTERVAL_MS during a long step. A
   * running run without one for WORKFLOW_STALE_AFTER_MS was interrupted.
   */
  heartbeat_at?: string;
  completed_at?: string;
  failed_at?: string;
  cancelled_at?: string;
  cancelled_by?: string;
  failure_reason?: string;
  /** Stable code of the error that failed the run, when it has one (e.g. ai_not_enabled, workflow_interrupted). */
  failure_code?: string;
  /** The next chunk while the run is running; null once it stopped. Runs from before durable chunks have none. */
  chunk?: WorkflowChunk | null;
  triggered_by: 'manual' | 'schedule' | 'webhook' | 'chat';
  created_by: string;
}
