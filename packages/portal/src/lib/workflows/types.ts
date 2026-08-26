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
  setProgress(progress: WorkflowProgress): void;
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
  started_at?: string;
  completed_at?: string;
  failed_at?: string;
  failure_reason?: string;
  triggered_by: 'manual' | 'schedule' | 'webhook' | 'chat';
  created_by: string;
}
