/**
 * Deploy job queue abstraction.
 *
 * Two implementations:
 *   - InProcessQueue    runs the deploy inline as a fire-and-forget Promise.
 *                       Used for local dev (no infra to set up, instant
 *                       feedback). Caveat: not safe on Cloud Run without
 *                       `--cpu-always-allocated`, and process restarts mid-
 *                       deploy lose the work.
 *   - CloudTasksQueue   enqueues an HTTP task. Cloud Tasks then calls the
 *                       portal's deploy-worker route in a separate request
 *                       that keeps the Cloud Run instance alive for the
 *                       duration. Retries, backoff, and visibility are all
 *                       provided by the queue.
 *
 * Choice is per-process via DEPLOY_QUEUE env var. Default in_process.
 *
 * The DeployJob doc is the single source of truth for status — both
 * implementations write to it the same way, so consumers (poll endpoint,
 * dashboard, deploy button) don't care which backend ran the work.
 */

import { runDeploy } from './runner';
import { getStore } from '../datastore';
import { computeDeployCost, getRateCard, PhaseTimer } from './cost';
import { acquireBuildSlot } from './concurrency';
import { paths, MAIN_VERSION_ID } from '@typeroll/shared';

export interface EnqueueArgs {
  jobId: string;
  orgId: string;
  siteId: string;
  versionId: string;
  environment: 'staging' | 'production';
  /**
   * Skip the hosting-adapter upload phase. Build runs as normal —
   * materializing fixtures, running astro build, writing _redirects/
   * _headers, bundling block assets — but the resulting dist/ never
   * leaves the worker. Useful for agents that want to validate a
   * structural change (new collection routes, schema bump) without
   * risking the live site.
   */
  dryRun?: boolean;
}

export interface DeployQueue {
  /** Hand off the deploy. Returns once the task is durably accepted (not
   *  once it's done). For in-process this is immediate; for Cloud Tasks
   *  this is the Cloud Tasks createTask call. */
  enqueue(args: EnqueueArgs): Promise<void>;
}

// ─── In-process (local dev) ─────────────────────────────────────────────

export class InProcessQueue implements DeployQueue {
  async enqueue(args: EnqueueArgs): Promise<void> {
    // Fire-and-forget on the current event loop. The HTTP response from
    // the launcher returns immediately; this Promise resolves on its
    // own. The .catch is essential — without it, any failure (real
    // deploy error OR a test runner cleaning up the fixtures dir before
    // the deploy finishes) becomes an unhandled rejection and crashes
    // the process / CI test runner. The error is already written to
    // the deploy job's status doc by runDeployInline when possible;
    // logging here covers the case where even the status write fails.
    runDeployInline(args).catch((err) => {
      console.error('[in-process deploy] background failure:', err);
    });
  }
}

/**
 * `deferred` means no build slot was free within the wait budget — the caller
 * should hand the task back so it is redelivered, NOT mark the job failed. A
 * congested platform is not a broken build, and showing the user a failure
 * they can't act on is worse than a late deploy.
 */
export type DeployRunOutcome = 'ran' | 'deferred';

async function runDeployInline(
  args: EnqueueArgs,
  opts: { slotWaitMs?: number } = {},
): Promise<DeployRunOutcome> {
  // One build per process at a time (DEPLOY_MAX_CONCURRENT, default 1). Taken
  // here rather than in either caller for the same reason cost accounting
  // lives here: this is the ONE execution path both queue backends share, so
  // a new backend inherits the gate instead of having to remember it.
  const slot = await acquireBuildSlot(opts.slotWaitMs ?? Infinity);
  if (!slot) return 'deferred';
  try {
    await runDeployBody(args);
    return 'ran';
  } finally {
    slot.release();
  }
}

async function runDeployBody(args: EnqueueArgs): Promise<void> {
  const store = getStore();
  const jobPath = paths.deploy(args.orgId, args.siteId, args.jobId);
  // Wrap each store write in its own swallow so a failed status update
  // (e.g. underlying fixtures dir was torn down by a test) doesn't
  // bubble out as an unhandled rejection.
  const safeUpdate = async (patch: Record<string, unknown>): Promise<void> => {
    try { await store.updateDoc(jobPath, patch); } catch { /* best effort */ }
  };

  // Cost accounting. This function is the ONE execution path both queue
  // backends use (in-process and the Cloud Tasks worker), so metering here
  // covers every deploy without either caller having to remember to.
  //
  // The clock starts before runDeploy and stops in the finally: a failed
  // build burns the same instance-time as a successful one, so it gets a
  // cost row too. Otherwise a site stuck in a build-failure loop would look
  // free in the report — exactly backwards.
  const rates = getRateCard();
  const timer = new PhaseTimer();
  const startedMs = Date.now();
  let outputBytes: number | undefined;
  let outputFiles: number | undefined;

  await safeUpdate({ status: 'running', phase: 'starting' });
  try {
    const result = await runDeploy({
      orgId: args.orgId,
      siteId: args.siteId,
      versionId: args.versionId ?? MAIN_VERSION_ID,
      environment: args.environment,
      buildOnly: args.dryRun === true,
      onPhase: (phase) => {
        timer.enter(phase);
        return safeUpdate({ phase });
      },
    });
    outputBytes = result.outputBytes;
    outputFiles = result.outputFiles;
    await safeUpdate({
      status: 'succeeded',
      phase: args.dryRun ? 'done (dry-run, no upload)' : 'done',
      finished_at: new Date().toISOString(),
      deploy_url: args.dryRun ? null : (result.deploy?.url ?? null),
      dry_run: args.dryRun === true,
      cost: computeDeployCost({
        durationMs: Date.now() - startedMs,
        rates,
        phaseMs: timer.finish(),
        outputBytes,
        outputFiles,
      }),
    });
  } catch (e) {
    await safeUpdate({
      status: 'failed',
      phase: 'failed',
      finished_at: new Date().toISOString(),
      error: e instanceof Error ? e.message : String(e),
      cost: computeDeployCost({
        durationMs: Date.now() - startedMs,
        rates,
        phaseMs: timer.finish(),
      }),
    });
  }
}

/**
 * Exported so the worker route can reuse the same execution path.
 *
 * The worker passes a finite `slotWaitMs` because Cloud Tasks WILL redeliver a
 * handed-back task; the in-process backend passes none (Infinity) because it
 * is fire-and-forget with no redelivery, so giving up there would silently
 * drop a deploy the user asked for.
 */
export async function executeDeployJob(
  args: EnqueueArgs,
  opts: { slotWaitMs?: number } = {},
): Promise<DeployRunOutcome> {
  return runDeployInline(args, opts);
}

// ─── Cloud Tasks (staging / prod) ───────────────────────────────────────

export class CloudTasksQueue implements DeployQueue {
  constructor(
    private queue: string, // projects/{p}/locations/{l}/queues/{q}
    private workerUrl: string, // public URL of /api/internal/deploy-worker
    private serviceAccountEmail: string, // OIDC token "sub" used by Cloud Tasks
  ) {}

  async enqueue(args: EnqueueArgs): Promise<void> {
    // Dynamic import so the @google-cloud/tasks SDK is only loaded in the
    // environment where it's actually used. Keeps `npm run dev:portal`
    // free of unnecessary GCP wiring.
    const { CloudTasksClient } = await import('@google-cloud/tasks');
    const client = new CloudTasksClient();

    await client.createTask({
      parent: this.queue,
      task: {
        // Cloud Tasks dedup window is 1h on the task name; using jobId
        // means a retried POST /deploy that already enqueued doesn't
        // double-deploy. We accept the 1h limit — that's plenty for
        // deploy idempotency.
        name: `${this.queue}/tasks/${args.jobId}`,
        httpRequest: {
          httpMethod: 'POST',
          url: this.workerUrl,
          headers: { 'Content-Type': 'application/json' },
          body: Buffer.from(JSON.stringify(args)).toString('base64'),
          oidcToken: {
            serviceAccountEmail: this.serviceAccountEmail,
            audience: this.workerUrl,
          },
        },
      },
    });
  }
}

// ─── Factory ─────────────────────────────────────────────────────────────

let cached: DeployQueue | null = null;

export function getDeployQueue(): DeployQueue {
  if (cached) return cached;
  const mode = (process.env.DEPLOY_QUEUE ?? 'in_process').toLowerCase();
  if (mode === 'cloud_tasks') {
    const queue   = process.env.CLOUD_TASKS_QUEUE;
    const url     = process.env.DEPLOY_WORKER_URL;
    const sa      = process.env.CLOUD_TASKS_SERVICE_ACCOUNT;
    if (!queue || !url || !sa) {
      throw new Error(
        'DEPLOY_QUEUE=cloud_tasks requires CLOUD_TASKS_QUEUE, DEPLOY_WORKER_URL, and CLOUD_TASKS_SERVICE_ACCOUNT.',
      );
    }
    cached = new CloudTasksQueue(queue, url, sa);
  } else {
    cached = new InProcessQueue();
  }
  return cached;
}
