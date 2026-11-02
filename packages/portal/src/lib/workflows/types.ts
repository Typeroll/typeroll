// Workflow engine types.
//
// A workflow is an ordered list of steps. Each step receives the workflow's
// accumulated state and returns updates to it. Steps can pause the workflow
// to wait for human review.

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

export type StepResult =
  | { state?: Record<string, unknown>; results?: Record<string, unknown> }
  | ReviewGate;

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
  triggered_by: 'manual' | 'schedule' | 'webhook' | 'chat';
  created_by: string;
}
