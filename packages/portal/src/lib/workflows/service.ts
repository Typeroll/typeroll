// Site workflow operations shared by the portal session routes
// (/api/sites/{siteId}/workflows/*) and the public API
// (/api/v1/sites/{siteId}/workflows/*). Route handlers authenticate and
// check the caller's permission on the site; everything after that lives
// here so the UI, the API and MCP start, read and approve workflows the
// same way.

import { paths } from '@typeroll/shared';
import type { SharePermission, WorkflowType } from '@typeroll/shared';
import { getStore } from '../datastore';
import { requireImportStorage } from '../media/import-policy';
import { WorkflowEngine } from './engine';
import { getWorkflowDef, workflows } from './registry';
import type { WorkflowRecord } from './types';

export class WorkflowRequestError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

/** Workflow ids as WorkflowEngine.create mints them, plus room for legacy ids. */
const WORKFLOW_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** Config keys that carry credentials. Stored for the run, never returned. */
const SECRET_CONFIG_KEYS = new Set(['helper_api_key']);

/**
 * Minimum site permission to start a workflow of this type. Most workflows
 * edit content and need `write`. Rebuild & deploy publishes the site, and
 * publishing needs `admin` everywhere else (the deploy routes in the UI and
 * the API), so a workflow must not become a way around that.
 */
export function workflowStartPermission(type: WorkflowType): SharePermission {
  return type === 'rebuild_deploy' ? 'admin' : 'write';
}

const PERMISSION_RANK: Record<SharePermission, number> = { read: 0, write: 1, admin: 2 };

/** True when `actual` covers `required` (read < write < admin). */
export function permissionCovers(actual: SharePermission, required: SharePermission): boolean {
  return PERMISSION_RANK[actual] >= PERMISSION_RANK[required];
}

/** The workflow catalog, as the UI's "Available workflows" list shows it. */
export function listWorkflowTypes() {
  return Object.values(workflows).map((def) => ({
    type: def.type,
    label: def.label,
    description: def.description,
    required_permission: workflowStartPermission(def.type),
    // Any step may pause the run for review; get the run's status to know.
    steps: def.steps.map((step) => ({ name: step.name, label: step.label })),
  }));
}

/**
 * The projection of a workflow run that leaves the server. Internal step
 * state is omitted (it is working memory, can be large, and repeats inputs
 * such as a WordPress helper key); credential-bearing config keys are masked.
 */
export function workflowSummary(wf: WorkflowRecord) {
  const config: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(wf.config ?? {})) {
    config[key] = SECRET_CONFIG_KEYS.has(key) && value ? '********' : value;
  }
  return {
    id: wf.id,
    site_id: wf.site_id,
    type: wf.type,
    status: wf.status,
    config,
    results: wf.results ?? {},
    current_step: wf.current_step ?? null,
    step_index: wf.step_index ?? null,
    progress: wf.progress ?? null,
    log: wf.log ?? [],
    review_message: wf.review_message ?? null,
    review_data: wf.review_data ?? null,
    started_at: wf.started_at ?? null,
    completed_at: wf.completed_at ?? null,
    failed_at: wf.failed_at ?? null,
    failure_reason: wf.failure_reason ?? null,
    triggered_by: wf.triggered_by,
    created_by: wf.created_by,
  };
}

/** Resolve a requested workflow type, or throw a 400 naming the valid ones. */
export function resolveWorkflowType(value: unknown): WorkflowType {
  if (typeof value !== 'string' || !value) throw new WorkflowRequestError('Missing type');
  try {
    return getWorkflowDef(value as WorkflowType).type;
  } catch {
    throw new WorkflowRequestError(`Unknown workflow type "${value}". Valid types: ${Object.keys(workflows).join(', ')}`);
  }
}

/**
 * Create a workflow run for a site and start it in the background. Returns as
 * soon as the run is recorded; callers poll readSiteWorkflow. Migration
 * requires the organization's own import storage and throws the same
 * ConnectionError the UI shows when it is not ready.
 */
export async function startSiteWorkflow(input: {
  orgId: string;
  siteId: string;
  type: WorkflowType;
  config?: unknown;
  versionId: string;
  createdBy: string;
}): Promise<{ workflowId: string }> {
  const def = getWorkflowDef(input.type);
  if (input.config !== undefined && (typeof input.config !== 'object' || input.config === null || Array.isArray(input.config))) {
    throw new WorkflowRequestError('config must be an object');
  }
  if (def.type === 'migration') await requireImportStorage(input.orgId);
  const engine = new WorkflowEngine();
  const workflowId = await engine.create({
    orgId: input.orgId,
    siteId: input.siteId,
    def,
    config: { ...(input.config as Record<string, unknown> | undefined), version: input.versionId },
    triggeredBy: 'manual',
    createdBy: input.createdBy,
  });
  // Run in the background; the caller polls for status.
  engine.start(input.orgId, workflowId, def).catch((err) => {
    console.error(`[workflow ${workflowId}] failed:`, err);
  });
  return { workflowId };
}

/** Read one run, only if it belongs to this site. */
export async function readSiteWorkflow(orgId: string, siteId: string, workflowId: string | undefined): Promise<WorkflowRecord | null> {
  if (!workflowId || !WORKFLOW_ID.test(workflowId)) return null;
  const wf = await getStore().getDoc<WorkflowRecord>(`${paths.workflows(orgId)}/${workflowId}`);
  if (!wf || wf.site_id !== siteId) return null;
  return wf;
}

/** Most recent runs for a site, newest first — the UI's "Recent runs". */
export async function listSiteWorkflows(orgId: string, siteId: string, limit = 20): Promise<WorkflowRecord[]> {
  const all = await getStore().listDocs<WorkflowRecord>(paths.workflows(orgId));
  return all
    .filter((w) => w.site_id === siteId)
    .sort((a, b) => (b.started_at ?? '').localeCompare(a.started_at ?? ''))
    .slice(0, Math.max(1, Math.min(limit, 100)));
}

/**
 * Approve the review gate of a paused run and resume it in the background
 * from the next step. Only a run that is paused for review can be approved.
 */
export async function approveSiteWorkflow(orgId: string, siteId: string, workflowId: string | undefined): Promise<WorkflowRecord> {
  const wf = await readSiteWorkflow(orgId, siteId, workflowId);
  if (!wf) throw new WorkflowRequestError('Not found', 404);
  if (wf.status !== 'paused_for_review') {
    throw new WorkflowRequestError(`Only a workflow paused for review can be approved; this one is ${wf.status}.`, 409);
  }
  const def = getWorkflowDef(wf.type);
  if (def.type === 'migration') await requireImportStorage(orgId);
  const engine = new WorkflowEngine();
  engine.resume(orgId, wf.id, def).catch((err) => {
    console.error(`[workflow ${wf.id}] resume failed:`, err);
  });
  return wf;
}
