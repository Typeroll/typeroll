/**
 * Deploy job queue.
 *
 * Enqueueing a deploy writes one `deploy_dispatch` entry in the scheduled-work
 * index (lib/scheduling), next to the job in its site's store object. The
 * scheduling transport delivers it: the site object's alarm on Cloudflare,
 * in-process timers in development. Delivery runs `executeDeployJob`; the job
 * document decides whether it still runs, so late or repeated deliveries are
 * harmless.
 *
 * The DeployJob doc is the single source of truth for status, so consumers
 * (poll endpoint, dashboard, deploy button) never see the transport.
 */

import { runDeploy } from './runner';
import { getStore } from '../datastore';
import { computeDeployCost, getRateCard, PhaseTimer } from './cost';
import { acquireBuildSlot } from './concurrency';
import { paths, MAIN_VERSION_ID } from '@typeroll/shared';
import { assertPublishingReady } from '../publishing/readiness';
import { putScheduledWork } from '../scheduling/index';

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
  /** A separately deduplicated continuation of the same frozen publication. */
  dispatchKey?: string;
  /** Internal durable observation delay; never delays the accepted site publication itself. */
  delayMs?: number;
}

export interface DeployQueue {
  /** Hand off the deploy. Resolves once it is durably accepted, not once it is done. */
  enqueue(args: EnqueueArgs): Promise<void>;
}

/** A repeated request has the same identity; a continuation of the same job has its own. */
export function deployTaskIdentity(args: Pick<EnqueueArgs, 'jobId' | 'dispatchKey'>): string {
  if (args.dispatchKey !== undefined && !/^[A-Za-z0-9-]{1,64}$/.test(args.dispatchKey)) throw new Error('Invalid deploy continuation identity');
  return args.dispatchKey ? `${args.jobId}-${args.dispatchKey}` : args.jobId;
}

/**
 * The one deploy queue. A dispatch replaces the job's pending one; the same
 * identity again (a retried request) is accepted without a second delivery.
 */
export class ScheduledDeployQueue implements DeployQueue {
  constructor(private readonly now: () => number = Date.now) {}

  async enqueue(args: EnqueueArgs): Promise<void> {
    const identity = deployTaskIdentity(args);
    if (!args.dryRun) await assertPublishingReady(args.orgId, args.siteId, args.versionId, { checkBuild: !args.dispatchKey });
    await putScheduledWork({
      kind: 'deploy_dispatch',
      source: paths.deploy(args.orgId, args.siteId, args.jobId),
      due_at: this.now() + Math.max(0, args.delayMs ?? 0),
      generation: identity,
      payload: { version_id: args.versionId, environment: args.environment, dry_run: args.dryRun === true, dispatch_key: args.dispatchKey ?? null },
    }, { dedupe: true });
  }
}

/**
 * `deferred` means no build slot was free within the wait budget — the caller
 * should hand the task back so it is redelivered, NOT mark the job failed. A
 * congested platform is not a broken build, and showing the user a failure
 * they can't act on is worse than a late deploy.
 */
/** continue means the next coordinator phase has been durably saved; consume this delivery. */
export type DeployRunOutcome = 'ran' | 'deferred' | 'continue' | 'waiting';

async function runDeployInline(
  args: EnqueueArgs,
  opts: { slotWaitMs?: number } = {},
): Promise<DeployRunOutcome> {
  const site = await getStore().getDoc<{ publishing_mode?: string }>(paths.site(args.orgId, args.siteId));
  const retry = site?.publishing_mode !== 'customer_git' && (await getStore().getDoc<{ verification_retry?: unknown }>(paths.deploy(args.orgId, args.siteId, args.jobId)))?.verification_retry;
  if (site?.publishing_mode === 'customer_git' || retry) {
    const { executeCustomerPublication } = await import('../publishing/customer-runner');
    return executeCustomerPublication(args);
  }
  // One build per process at a time (DEPLOY_MAX_CONCURRENT, default 1). Taken
  // here for the same reason cost accounting lives here: this is the ONE
  // execution path every delivery shares.
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

  // Cost accounting. This function is the ONE execution path every queue
  // backend uses, so metering here
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
    if (!args.dryRun) await assertPublishingReady(args.orgId, args.siteId, args.versionId, { checkBuild: false });
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
      status: result.availability ? 'running' : 'succeeded',
      phase: result.availability ? 'distributing' : args.dryRun ? 'done (dry-run, no upload)' : 'done',
      ...(!result.availability ? { finished_at: new Date().toISOString() } : { availability: result.availability }),
      deploy_url: args.dryRun ? null : (result.deploy?.url ?? null),
      dry_run: args.dryRun === true,
      warnings: result.warnings ?? [],
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
 * The execution path of every delivered deploy (scheduling/worker.ts).
 *
 * Deliveries pass a finite `slotWaitMs`: a handed-back delivery is retried by
 * the scheduling transport. Without one it waits for a slot indefinitely.
 */
export async function executeDeployJob(
  args: EnqueueArgs,
  opts: { slotWaitMs?: number } = {},
): Promise<DeployRunOutcome> {
  return runDeployInline(args, opts);
}

let cached: DeployQueue | null = null;

export function getDeployQueue(): DeployQueue {
  return cached ??= new ScheduledDeployQueue();
}
