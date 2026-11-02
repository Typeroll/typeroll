// Workflow engine.
//
// Runs the steps of a workflow definition in order, persisting state to the
// datastore. Steps can pause the workflow with reviewGate(...) — the engine
// writes status=paused_for_review and exits. The portal's /approve endpoint
// re-enters the engine starting from the next step.
//
// Runs execute in short chunks, never as a background promise of the request
// that started them: on Cloud Run with request-based CPU such a promise gets
// almost no CPU once the response is sent and dies with the instance. start()
// and resume() only record the run's first chunk and enqueue it on a durable
// queue (queue.ts); each delivery runs one chunk inside a request of its own.
// A chunk runs steps until its time budget (WORKFLOW_CHUNK_BUDGET_MS) is
// spent. A long per-item step yields with a cursor (stepYield) when the budget
// is spent; the engine persists the cursor and enqueues the next chunk, which
// continues the step from it, possibly in another process.
//
// Every chunk has an id. A delivery runs only while the stored run names its
// id, under a lease, and commits with a compare-and-update on {id,
// step_index, cursor, lease owner} that replaces the id. Duplicate and late
// deliveries (Cloud Tasks is at-least-once) therefore do nothing, and a
// cancelled run stops at the next chunk boundary. A chunk whose process went
// away is resumed from its cursor: by the queue's own retry once its lease
// expires, or by the read that finds the run stale (run-lifecycle.ts).

import { randomUUID } from 'node:crypto';
import type { WorkflowType } from '@typeroll/shared';
import { requireImportStorage } from '../media/import-policy';
import { paths } from '@typeroll/shared';
import type { ReadWriteStore } from '../datastore';
import { getStore } from '../datastore';
import { WORKFLOW_HEARTBEAT_INTERVAL_MS } from './run-lifecycle';
import { workflowChunkQueue, type WorkflowChunkQueue, type WorkflowChunkRef } from './queue';
import {
  type StepResult,
  type WorkflowChunk,
  type WorkflowContext,
  type WorkflowDef,
  type WorkflowRecord,
  isReviewGate,
  isStepYield,
} from './types';

/** Time a chunk may start new work for. Items in flight finish after it. */
export const WORKFLOW_CHUNK_BUDGET_MS = 45_000;

/**
 * How long a delivery holds its chunk: longer than any chunk takes (its
 * budget plus the slowest item in flight), so only a chunk whose process
 * died is ever run again. Equal to the scheduled-work lease.
 */
export const WORKFLOW_CHUNK_LEASE_MS = 5 * 60_000;

/** How long a committed chunk may wait for its own delivery before a stale delivery re-sends it. */
const SUPERSEDED_GRACE_MS = WORKFLOW_HEARTBEAT_INTERVAL_MS;

export type ChunkOutcome =
  /** The run does not exist. */
  | 'missing'
  /** The run is no longer running (completed, failed, cancelled, paused). */
  | 'not_running'
  /** Another chunk is current: a duplicate or late delivery. With leaseUntil: retry it then. */
  | 'superseded'
  /** The chunk is being executed under another delivery's lease, until leaseUntil. */
  | 'busy'
  /** The chunk ran and the next one is enqueued. */
  | 'continued'
  | 'paused'
  | 'completed'
  | 'failed'
  /** The run was cancelled or taken over while the chunk ran; nothing was committed. */
  | 'stopped';

export interface WorkflowEngineOptions {
  now?: () => number;
  /**
   * Where chunks go. Default: the durable queue of this deployment. 'inline'
   * runs them one after another inside start() and resume(), which then
   * return the finished run (tests and tools).
   */
  queue?: WorkflowChunkQueue | 'inline';
  chunkBudgetMs?: number;
  /** The definition of a run's type, for chunks delivered without one. */
  resolveDef?: (type: WorkflowType) => WorkflowDef | Promise<WorkflowDef>;
}

const defaultResolveDef = async (type: WorkflowType) => (await import('./registry')).getWorkflowDef(type);

export class WorkflowEngine {
  private readonly now: () => number;
  private readonly queue: WorkflowChunkQueue | null;
  private readonly inlinePending: WorkflowChunkRef[] = [];
  private draining = false;
  private readonly chunkBudgetMs: number;
  private readonly resolveDef: (type: WorkflowType) => WorkflowDef | Promise<WorkflowDef>;

  constructor(private store: ReadWriteStore = getStore(), options: WorkflowEngineOptions = {}) {
    this.now = options.now ?? Date.now;
    this.queue = options.queue === 'inline' ? null : options.queue ?? workflowChunkQueue();
    this.chunkBudgetMs = options.chunkBudgetMs ?? WORKFLOW_CHUNK_BUDGET_MS;
    this.resolveDef = options.resolveDef ?? defaultResolveDef;
  }

  private iso(t = this.now()): string {
    return new Date(t).toISOString();
  }

  private async current(wfPath: string): Promise<WorkflowRecord> {
    return (await this.store.getDoc<WorkflowRecord>(wfPath))!;
  }

  private newChunk(stepIndex: number, cursor: string | null, seq: number): WorkflowChunk {
    return { id: randomUUID(), step_index: stepIndex, cursor, lease_owner: null, lease_until: 0, resumes: 0, seq };
  }

  private async dispatch(ref: WorkflowChunkRef): Promise<void> {
    if (this.queue) await this.queue.enqueue(ref);
    else this.inlinePending.push(ref);
  }

  /** Inline mode: run queued chunks until none is left. */
  private async drainInline(def: WorkflowDef): Promise<void> {
    if (this.queue || this.draining) return;
    this.draining = true;
    try {
      for (let ref = this.inlinePending.shift(); ref; ref = this.inlinePending.shift()) await this.runChunk(ref, def);
    } finally {
      this.draining = false;
    }
  }

  async create(args: {
    orgId: string;
    siteId: string;
    def: WorkflowDef;
    config?: Record<string, unknown>;
    triggeredBy: WorkflowRecord['triggered_by'];
    createdBy: string;
  }): Promise<string> {
    if (args.def.type === 'migration') await requireImportStorage(args.orgId);
    const workflowId = `wf_${this.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const record: Omit<WorkflowRecord, 'id'> = {
      site_id: args.siteId,
      type: args.def.type,
      status: 'pending',
      config: args.config ?? {},
      state: {},
      results: {},
      step_index: 0,
      progress: { total: args.def.steps.length, completed: 0 },
      log: [],
      triggered_by: args.triggeredBy,
      created_by: args.createdBy,
      created_at: this.iso(),
    };
    await this.store.setDoc(`${paths.workflows(args.orgId)}/${workflowId}`, record);
    return workflowId;
  }

  /** Mark a pending run running and enqueue its first chunk. */
  async start(orgId: string, workflowId: string, def: WorkflowDef): Promise<WorkflowRecord> {
    if (def.type === 'migration') await requireImportStorage(orgId);
    const wfPath = `${paths.workflows(orgId)}/${workflowId}`;
    const startedAt = this.iso();
    const chunk = this.newChunk(0, null, 0);
    const started = await this.store.compareAndUpdateDoc<WorkflowRecord>(wfPath, (wf) => wf.status === 'pending', {
      status: 'running',
      started_at: startedAt,
      heartbeat_at: startedAt,
      step_index: 0,
      chunk,
    });
    if (!started) return this.current(wfPath);
    await this.dispatch({ orgId, workflowId, chunkId: chunk.id });
    await this.drainInline(def);
    return this.current(wfPath);
  }

  /** Continues a paused workflow from the step after the one that paused. */
  async resume(orgId: string, workflowId: string, def: WorkflowDef): Promise<WorkflowRecord> {
    if (def.type === 'migration') await requireImportStorage(orgId);
    const wfPath = `${paths.workflows(orgId)}/${workflowId}`;
    const wf = await this.store.getDoc<WorkflowRecord>(wfPath);
    if (!wf) throw new Error('Workflow not found');
    if (wf.status !== 'paused_for_review') {
      throw new Error(`Cannot resume workflow in status ${wf.status}`);
    }
    const nextIndex = (wf.step_index ?? 0) + 1;
    const chunk = this.newChunk(nextIndex, null, wf.chunk?.seq ?? 0);
    // Conditional, so a second approval or a cancel in between cannot start
    // the remaining steps twice or revive a cancelled run.
    const resumed = await this.store.compareAndUpdateDoc<WorkflowRecord>(wfPath, (current) => current.status === 'paused_for_review', {
      status: 'running',
      heartbeat_at: this.iso(),
      review_message: null,
      review_data: null,
      chunk,
    });
    if (!resumed) return this.current(wfPath);
    await this.dispatch({ orgId, workflowId, chunkId: chunk.id });
    await this.drainInline(def);
    return this.current(wfPath);
  }

  /**
   * Execute one delivered chunk: run steps from the chunk's step and cursor
   * until the run finishes, pauses, fails, or the chunk's budget is spent,
   * then commit and enqueue the next chunk. Safe to call with any delivery:
   * one that is not the run's current chunk does nothing.
   */
  async runChunk(ref: WorkflowChunkRef, defArg?: WorkflowDef): Promise<{ outcome: ChunkOutcome; leaseUntil?: number }> {
    const { orgId, workflowId } = ref;
    const wfPath = `${paths.workflows(orgId)}/${workflowId}`;
    const wf = await this.store.getDoc<WorkflowRecord>(wfPath);
    if (!wf) return { outcome: 'missing' };
    if (wf.status !== 'running') return { outcome: 'not_running' };
    const chunk = wf.chunk;
    if (!chunk || chunk.id !== ref.chunkId) {
      // A duplicate or late delivery. The current chunk's own delivery may
      // still have been lost between its commit and its enqueue (the process
      // died there). While another delivery holds the current chunk, or it
      // was committed moments ago, ask to be retried later; a chunk that
      // stays idle after that is delivered again (a duplicate is a no-op).
      if (!chunk) return { outcome: 'superseded' };
      const t = this.now();
      if (chunk.lease_until > t) return { outcome: 'superseded', leaseUntil: chunk.lease_until };
      const idleSince = Date.parse(wf.heartbeat_at ?? '') || 0;
      if (t - idleSince < SUPERSEDED_GRACE_MS) return { outcome: 'superseded', leaseUntil: idleSince + SUPERSEDED_GRACE_MS };
      await this.dispatch({ orgId, workflowId, chunkId: chunk.id });
      return { outcome: 'superseded' };
    }
    if (chunk.lease_until > this.now()) return { outcome: 'busy', leaseUntil: chunk.lease_until };

    const def = defArg ?? await this.resolveDef(wf.type);
    const owner = randomUUID();
    const chunkStart = this.now();
    const deadline = chunkStart + this.chunkBudgetMs;
    let current: WorkflowChunk = { ...chunk, lease_owner: owner, lease_until: chunkStart + WORKFLOW_CHUNK_LEASE_MS };
    const firstStep = def.steps[current.step_index];
    const claimed = await this.store.compareAndUpdateDoc<WorkflowRecord>(
      wfPath,
      (stored) => stored.status === 'running' && stored.chunk?.id === chunk.id && (stored.chunk.lease_until ?? 0) <= chunkStart,
      { chunk: current, heartbeat_at: this.iso(chunkStart), ...(firstStep ? { current_step: firstStep.name, step_index: current.step_index } : {}) },
    );
    if (!claimed) {
      const now = await this.store.getDoc<WorkflowRecord>(wfPath);
      if (now?.status === 'running' && now.chunk?.id === chunk.id) return { outcome: 'busy', leaseUntil: now.chunk.lease_until };
      return { outcome: now?.status === 'running' ? 'superseded' : 'not_running' };
    }

    /** Commit only while this delivery still holds exactly this chunk. */
    const holds = (stored: WorkflowRecord) => stored.status === 'running'
      && stored.chunk?.id === current.id
      && stored.chunk.step_index === current.step_index
      && (stored.chunk.cursor ?? null) === current.cursor
      && stored.chunk.lease_owner === owner;
    const commit = async (data: Record<string, unknown>): Promise<boolean> =>
      (await this.store.compareAndUpdateDoc<WorkflowRecord>(wfPath, holds, { ...data, heartbeat_at: this.iso() })) !== null;

    let state = wf.state ?? {};
    let results = wf.results ?? {};
    const log: string[] = wf.log ?? [];

    for (;;) {
      const i = current.step_index;
      const step = def.steps[i];
      if (!step) {
        return (await commit({ status: 'completed', current_step: undefined, completed_at: this.iso(), chunk: null, log }))
          ? { outcome: 'completed' } : { outcome: 'stopped' };
      }

      // Liveness during the step: progress reports carry a heartbeat at most
      // every WORKFLOW_HEARTBEAT_INTERVAL_MS, and a timer covers steps that
      // report no progress. Once a heartbeat finds that this delivery no
      // longer holds the chunk (cancelled, or resumed elsewhere after an
      // interruption), progress writes stop and the step is asked to yield.
      let lastBeat = this.now();
      let stopped = false;
      const heartbeatDue = () => {
        const t = this.now();
        if (t - lastBeat < WORKFLOW_HEARTBEAT_INTERVAL_MS) return null;
        lastBeat = t;
        return new Date(t).toISOString();
      };
      const beat = () => {
        if (stopped) return;
        const at = heartbeatDue();
        if (!at) return;
        this.store.compareAndUpdateDoc<WorkflowRecord>(wfPath, holds, { heartbeat_at: at })
          .then((previous) => { if (!previous) stopped = true; })
          .catch((err) => console.warn(`[workflow ${workflowId}] heartbeat failed:`, err));
      };
      const keepalive = setInterval(beat, WORKFLOW_HEARTBEAT_INTERVAL_MS);
      (keepalive as { unref?: () => void }).unref?.();

      const ctx: WorkflowContext = {
        orgId,
        siteId: wf.site_id,
        workflowId,
        config: wf.config,
        state,
        store: this.store,
        log: (msg: string) => log.push(`[${step.name}] ${msg}`),
        setProgress: (p) => {
          if (stopped) return;
          // Fire-and-forget progress writes are fine — the step's next
          // commit overwrites stale values anyway.
          const at = heartbeatDue();
          void this.store.updateDoc(wfPath, at ? { progress: p, heartbeat_at: at } : { progress: p });
        },
        heartbeat: beat,
        cursor: current.cursor === null ? undefined : JSON.parse(current.cursor),
        shouldYield: () => stopped || this.now() >= deadline,
      };

      let result: StepResult;
      try {
        if (def.type === 'migration') await requireImportStorage(orgId);
        result = await step.run(ctx);
      } catch (e) {
        clearInterval(keepalive);
        const msg = e instanceof Error ? e.message : String(e);
        log.push(`[${step.name}] ERROR: ${msg}`);
        const failed = await commit({
          status: 'failed',
          failed_at: this.iso(),
          failure_reason: `${step.name}: ${msg}`,
          // A stable code for errors that carry one (e.g. ai_not_enabled), so
          // API and MCP callers need not parse the message.
          ...(failureCode(e) ? { failure_code: failureCode(e) } : {}),
          chunk: null,
          log,
        });
        return { outcome: failed ? 'failed' : 'stopped' };
      }
      clearInterval(keepalive);

      if (isStepYield(result)) {
        const next = this.newChunk(i, JSON.stringify(result.cursor ?? null), current.seq + 1);
        if (!(await commit({ chunk: next, log }))) return { outcome: 'stopped' };
        await this.dispatch({ orgId, workflowId, chunkId: next.id });
        return { outcome: 'continued' };
      }

      if (isReviewGate(result)) {
        log.push(`[${step.name}] paused for review: ${result.message}`);
        const paused = await commit({
          status: 'paused_for_review',
          review_message: result.message,
          review_data: result.data ?? {},
          progress: { total: def.steps.length, completed: i + 1 },
          chunk: null,
          log,
        });
        return { outcome: paused ? 'paused' : 'stopped' };
      }

      state = { ...state, ...(result.state ?? {}) };
      results = { ...results, ...(result.results ?? {}) };
      log.push(`[${step.name}] done`);
      const progress = { total: def.steps.length, completed: i + 1 };
      const nextStep = def.steps[i + 1];

      if (!nextStep) {
        const completed = await commit({ state, results, progress, status: 'completed', current_step: undefined, completed_at: this.iso(), chunk: null, log });
        return { outcome: completed ? 'completed' : 'stopped' };
      }

      if (this.now() >= deadline || stopped) {
        // Budget spent: the next step starts in a fresh chunk.
        const next = this.newChunk(i + 1, null, current.seq + 1);
        if (!(await commit({ state, results, progress, chunk: next, log }))) return { outcome: 'stopped' };
        await this.dispatch({ orgId, workflowId, chunkId: next.id });
        return { outcome: 'continued' };
      }

      // Budget left: continue with the next step under the same lease.
      const next: WorkflowChunk = { ...this.newChunk(i + 1, null, current.seq + 1), lease_owner: owner, lease_until: this.now() + WORKFLOW_CHUNK_LEASE_MS };
      if (!(await commit({ state, results, progress, chunk: next, current_step: nextStep.name, step_index: i + 1, log }))) return { outcome: 'stopped' };
      current = next;
    }
  }
}

/** The application error code of a failed step (snake_case, e.g. ai_not_enabled); never a system code. */
function failureCode(error: unknown): string | undefined {
  const code = error instanceof Error ? (error as { code?: unknown }).code : undefined;
  return typeof code === 'string' && /^[a-z][a-z0-9_]*$/.test(code) ? code : undefined;
}
