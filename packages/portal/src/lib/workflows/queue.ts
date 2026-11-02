// Durable delivery of workflow chunks.
//
// A workflow run executes as a chain of short chunks (engine.ts). Each chunk
// is delivered through the scheduled-work index (scheduling/index.ts), the
// same outbox the publication chain and serving checks use, so a chunk runs
// inside a request of its own and survives the process that enqueued it:
//
//   - DEPLOY_QUEUE=cloud_tasks: Cloud Tasks posts the entry to
//     /api/internal/deploy-worker, which keeps the Cloud Run instance's CPU
//     allocated for the chunk. A failed delivery is retried by the queue;
//     the publish-sweep scheduler re-dispatches due entries whose submission
//     failed.
//   - DEPLOY_QUEUE=firestore (portable self-host): the worker loop's sweep
//     runs due entries.
//   - DEPLOY_QUEUE unset/in_process (development, simple self-host): process
//     timers deliver the entry in the same process, one chunk after another.
//
// One index entry per run; enqueueing the next chunk replaces it. The entry's
// generation is the chunk id, and the engine runs a chunk only while the run
// still names it, so stale and duplicate deliveries are harmless.

import { paths } from '@typeroll/shared';
import type { ReadWriteStore } from '../datastore';
import { getStore } from '../datastore';
import { notifyScheduledWrites, workPath, type ScheduledWork } from '../scheduling/index';

export interface WorkflowChunkRef {
  orgId: string;
  workflowId: string;
  chunkId: string;
}

export interface WorkflowChunkQueue {
  /** Accept the chunk for delivery. Resolves once it is durably recorded, not once it ran. */
  enqueue(ref: WorkflowChunkRef, delayMs?: number): Promise<void>;
}

export const workflowRunSource = (orgId: string, workflowId: string) => `${paths.workflows(orgId)}/${workflowId}`;

const SOURCE = /^organizations\/([^/]+)\/workflows\/([A-Za-z0-9_-]{1,128})$/;

/** The run a scheduled-work source names, or null for anything else. */
export function parseWorkflowRunSource(source: string): { orgId: string; workflowId: string } | null {
  const match = SOURCE.exec(source);
  return match ? { orgId: match[1], workflowId: match[2] } : null;
}

export class ScheduledWorkflowQueue implements WorkflowChunkQueue {
  constructor(private readonly store: ReadWriteStore = getStore(), private readonly now: () => number = Date.now) {}

  async enqueue(ref: WorkflowChunkRef, delayMs = 0): Promise<void> {
    const source = workflowRunSource(ref.orgId, ref.workflowId);
    const path = workPath(source, 'workflow_chunk');
    const work: ScheduledWork = {
      kind: 'workflow_chunk',
      source,
      generation: ref.chunkId,
      due_at: this.now() + Math.max(0, delayMs),
      payload: { chunk_id: ref.chunkId },
      lease_until: 0,
      lease_owner: null,
      blocked_by: null,
    };
    await this.store.setDoc(path, work as unknown as Record<string, unknown>);
    await notifyScheduledWrites([{ path, data: work }]);
  }
}

/** The durable queue for this deployment (see the header for the transports). */
export function workflowChunkQueue(): WorkflowChunkQueue {
  return new ScheduledWorkflowQueue();
}

/**
 * Execute one delivered chunk (scheduling/worker.ts). Returns when the same
 * delivery should be retried (epoch ms; the chunk is held by a lease that may
 * belong to a process that died), or null when it is consumed.
 */
export async function runScheduledWorkflowChunk(source: string, payload: Record<string, unknown>): Promise<number | null> {
  const run = parseWorkflowRunSource(source);
  const chunkId = payload.chunk_id;
  if (!run || typeof chunkId !== 'string' || !chunkId) return null;
  const { WorkflowEngine } = await import('./engine');
  const outcome = await new WorkflowEngine(getStore(), { queue: workflowChunkQueue() }).runChunk({ ...run, chunkId });
  // A chunk held by another delivery's lease is retried when the lease ends:
  // if that process died, this delivery then resumes the chunk from its cursor.
  return outcome.leaseUntil ? outcome.leaseUntil + 1_000 : null;
}
