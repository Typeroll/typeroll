// Workflow engine.
//
// Runs the steps of a workflow definition in order, persisting state to the
// datastore after each step. Steps can pause the workflow with reviewGate(...)
// — the engine writes status=paused_for_review and exits. The portal's
// /approve endpoint re-enters the engine starting from the next step.
//
// For now, workflows run inline in the request that triggered them. Long
// migrations would normally need a queue; that's a later concern. A process
// that goes away mid-run leaves the run `running`; the engine therefore
// records heartbeat_at, and reads close a run without one as interrupted
// (run-lifecycle.ts). Every status write is conditional on the run still
// being `running`, so a run that was cancelled or closed meanwhile stops at
// its next write instead of overwriting that outcome.

import { requireImportStorage } from '../media/import-policy';
import { paths } from '@typeroll/shared';
import type { ReadWriteStore } from '../datastore';
import { getStore } from '../datastore';
import { WORKFLOW_HEARTBEAT_INTERVAL_MS } from './run-lifecycle';
import {
  type StepResult,
  type WorkflowContext,
  type WorkflowDef,
  type WorkflowRecord,
  isReviewGate,
} from './types';

const isRunning = (wf: WorkflowRecord) => wf.status === 'running';

export class WorkflowEngine {
  private readonly now: () => number;

  constructor(private store: ReadWriteStore = getStore(), options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
  }

  private iso(): string {
    return new Date(this.now()).toISOString();
  }

  /**
   * Update the run only while it is still running. Returns false when it is
   * not (cancelled, or closed as interrupted), which ends the run here.
   */
  private async whileRunning(wfPath: string, data: Record<string, unknown>): Promise<boolean> {
    return (await this.store.compareAndUpdateDoc<WorkflowRecord>(wfPath, isRunning, { ...data, heartbeat_at: this.iso() })) !== null;
  }

  private async current(wfPath: string): Promise<WorkflowRecord> {
    return (await this.store.getDoc<WorkflowRecord>(wfPath))!;
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

  async start(orgId: string, workflowId: string, def: WorkflowDef): Promise<WorkflowRecord> {
    if (def.type === 'migration') await requireImportStorage(orgId);
    const wfPath = `${paths.workflows(orgId)}/${workflowId}`;
    const startedAt = this.iso();
    const started = await this.store.compareAndUpdateDoc<WorkflowRecord>(wfPath, (wf) => wf.status === 'pending', {
      status: 'running',
      started_at: startedAt,
      heartbeat_at: startedAt,
    });
    if (!started) return this.current(wfPath);
    return this.runFrom(orgId, workflowId, def, 0);
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
    // Conditional, so a second approval or a cancel in between cannot start
    // the remaining steps twice or revive a cancelled run.
    const resumed = await this.store.compareAndUpdateDoc<WorkflowRecord>(wfPath, (current) => current.status === 'paused_for_review', {
      status: 'running',
      heartbeat_at: this.iso(),
      review_message: null,
      review_data: null,
    });
    if (!resumed) return this.current(wfPath);
    return this.runFrom(orgId, workflowId, def, nextIndex);
  }

  private async runFrom(
    orgId: string,
    workflowId: string,
    def: WorkflowDef,
    startIndex: number
  ): Promise<WorkflowRecord> {
    const wfPath = `${paths.workflows(orgId)}/${workflowId}`;

    for (let i = startIndex; i < def.steps.length; i++) {
      const step = def.steps[i];
      const wf = await this.store.getDoc<WorkflowRecord>(wfPath);
      if (!wf) throw new Error('Workflow disappeared mid-run');

      if (!(await this.whileRunning(wfPath, { current_step: step.name, step_index: i }))) {
        return this.current(wfPath);
      }

      // Liveness during the step: progress reports carry a heartbeat at most
      // every WORKFLOW_HEARTBEAT_INTERVAL_MS, and a timer covers steps that
      // report no progress. Once a heartbeat finds the run no longer running
      // (cancelled, or closed as interrupted), progress writes stop too.
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
        this.store.compareAndUpdateDoc<WorkflowRecord>(wfPath, isRunning, { heartbeat_at: at })
          .then((previous) => { if (!previous) stopped = true; })
          .catch((err) => console.warn(`[workflow ${workflowId}] heartbeat failed:`, err));
      };
      const keepalive = setInterval(beat, WORKFLOW_HEARTBEAT_INTERVAL_MS);
      (keepalive as { unref?: () => void }).unref?.();

      const log: string[] = wf.log ?? [];
      const ctx: WorkflowContext = {
        orgId,
        siteId: wf.site_id,
        workflowId,
        config: wf.config,
        state: wf.state ?? {},
        store: this.store,
        log: (msg: string) => log.push(`[${step.name}] ${msg}`),
        setProgress: (p) => {
          if (stopped) return;
          // Fire-and-forget progress writes are fine — the next step will
          // re-read the doc and overwrite stale values anyway.
          const at = heartbeatDue();
          void this.store.updateDoc(wfPath, at ? { progress: p, heartbeat_at: at } : { progress: p });
        },
        heartbeat: beat,
      };

      let result: StepResult;
      try {
        if (def.type === 'migration') await requireImportStorage(orgId);
        result = await step.run(ctx);
      } catch (e) {
        clearInterval(keepalive);
        const msg = e instanceof Error ? e.message : String(e);
        log.push(`[${step.name}] ERROR: ${msg}`);
        await this.whileRunning(wfPath, {
          status: 'failed',
          failed_at: this.iso(),
          failure_reason: `${step.name}: ${msg}`,
          // A stable code for errors that carry one (e.g. ai_not_enabled), so
          // API and MCP callers need not parse the message.
          ...(failureCode(e) ? { failure_code: failureCode(e) } : {}),
          log,
        });
        return this.current(wfPath);
      }
      clearInterval(keepalive);

      if (isReviewGate(result)) {
        log.push(`[${step.name}] paused for review: ${result.message}`);
        await this.whileRunning(wfPath, {
          status: 'paused_for_review',
          review_message: result.message,
          review_data: result.data ?? {},
          progress: {
            total: def.steps.length,
            completed: i + 1,
          },
          log,
        });
        return this.current(wfPath);
      }

      const stateUpdate = result.state ?? {};
      const resultsUpdate = result.results ?? {};
      log.push(`[${step.name}] done`);

      const recorded = await this.whileRunning(wfPath, {
        state: { ...(wf.state ?? {}), ...stateUpdate },
        results: { ...(wf.results ?? {}), ...resultsUpdate },
        progress: {
          total: def.steps.length,
          completed: i + 1,
        },
        log,
      });
      if (!recorded) return this.current(wfPath);
    }

    await this.whileRunning(wfPath, {
      status: 'completed',
      current_step: undefined,
      completed_at: this.iso(),
    });
    return this.current(wfPath);
  }
}

/** The application error code of a failed step (snake_case, e.g. ai_not_enabled); never a system code. */
function failureCode(error: unknown): string | undefined {
  const code = error instanceof Error ? (error as { code?: unknown }).code : undefined;
  return typeof code === 'string' && /^[a-z][a-z0-9_]*$/.test(code) ? code : undefined;
}
