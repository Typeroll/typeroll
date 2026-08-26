// Workflow engine.
//
// Runs the steps of a workflow definition in order, persisting state to the
// datastore after each step. Steps can pause the workflow with reviewGate(...)
// — the engine writes status=paused_for_review and exits. The portal's
// /approve endpoint re-enters the engine starting from the next step.
//
// For now, workflows run inline in the request that triggered them. Long
// migrations would normally need a queue; that's a later concern.

import { paths } from '@typeroll/shared';
import type { ReadWriteStore } from '../datastore';
import { getStore } from '../datastore';
import {
  type StepResult,
  type WorkflowContext,
  type WorkflowDef,
  type WorkflowRecord,
  isReviewGate,
} from './types';

export class WorkflowEngine {
  constructor(private store: ReadWriteStore = getStore()) {}

  async create(args: {
    orgId: string;
    siteId: string;
    def: WorkflowDef;
    config?: Record<string, unknown>;
    triggeredBy: WorkflowRecord['triggered_by'];
    createdBy: string;
  }): Promise<string> {
    const workflowId = `wf_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
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
    };
    await this.store.setDoc(`${paths.workflows(args.orgId)}/${workflowId}`, record);
    return workflowId;
  }

  async start(orgId: string, workflowId: string, def: WorkflowDef): Promise<WorkflowRecord> {
    const wfPath = `${paths.workflows(orgId)}/${workflowId}`;
    await this.store.updateDoc(wfPath, {
      status: 'running',
      started_at: new Date().toISOString(),
    });
    return this.runFrom(orgId, workflowId, def, 0);
  }

  /** Continues a paused workflow from the step after the one that paused. */
  async resume(orgId: string, workflowId: string, def: WorkflowDef): Promise<WorkflowRecord> {
    const wfPath = `${paths.workflows(orgId)}/${workflowId}`;
    const wf = await this.store.getDoc<WorkflowRecord>(wfPath);
    if (!wf) throw new Error('Workflow not found');
    if (wf.status !== 'paused_for_review') {
      throw new Error(`Cannot resume workflow in status ${wf.status}`);
    }
    const nextIndex = (wf.step_index ?? 0) + 1;
    await this.store.updateDoc(wfPath, {
      status: 'running',
      review_message: null,
      review_data: null,
    });
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

      await this.store.updateDoc(wfPath, {
        current_step: step.name,
        step_index: i,
      });

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
          // Fire-and-forget progress writes are fine — the next step will
          // re-read the doc and overwrite stale values anyway.
          void this.store.updateDoc(wfPath, { progress: p });
        },
      };

      let result: StepResult;
      try {
        result = await step.run(ctx);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log.push(`[${step.name}] ERROR: ${msg}`);
        await this.store.updateDoc(wfPath, {
          status: 'failed',
          failed_at: new Date().toISOString(),
          failure_reason: `${step.name}: ${msg}`,
          log,
        });
        const finalWf = await this.store.getDoc<WorkflowRecord>(wfPath);
        return finalWf!;
      }

      if (isReviewGate(result)) {
        log.push(`[${step.name}] paused for review: ${result.message}`);
        await this.store.updateDoc(wfPath, {
          status: 'paused_for_review',
          review_message: result.message,
          review_data: result.data ?? {},
          progress: {
            total: def.steps.length,
            completed: i + 1,
          },
          log,
        });
        const pausedWf = await this.store.getDoc<WorkflowRecord>(wfPath);
        return pausedWf!;
      }

      const stateUpdate = result.state ?? {};
      const resultsUpdate = result.results ?? {};
      log.push(`[${step.name}] done`);

      await this.store.updateDoc(wfPath, {
        state: { ...(wf.state ?? {}), ...stateUpdate },
        results: { ...(wf.results ?? {}), ...resultsUpdate },
        progress: {
          total: def.steps.length,
          completed: i + 1,
        },
        log,
      });
    }

    await this.store.updateDoc(wfPath, {
      status: 'completed',
      current_step: undefined,
      completed_at: new Date().toISOString(),
    });
    const finalWf = await this.store.getDoc<WorkflowRecord>(wfPath);
    return finalWf!;
  }
}
