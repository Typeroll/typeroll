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

import { getStore } from '../datastore';
import { paths } from '@typeroll/shared';
import { assertPublishingReady, MANAGED_PUBLISHING_REMOVED } from '../publishing/readiness';
import { putScheduledWork } from '../scheduling/index';

export interface EnqueueArgs {
  jobId: string;
  orgId: string;
  siteId: string;
  versionId: string;
  environment: 'staging' | 'production';
  /**
   * Validate the publication without replacing the live site: the frozen
   * publication is prepared and checked, but never deployed. Useful for agents
   * that want to validate a structural change without risking the live site.
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
 * `deferred` means the publication is already executing elsewhere (its lease is
 * held): the delivery is handed back and redelivered, never marked failed.
 * `continue` means the next coordinator phase has been durably saved; consume
 * this delivery.
 */
export type DeployRunOutcome = 'ran' | 'deferred' | 'continue' | 'waiting';

/**
 * The execution path of every delivered deploy (scheduling/worker.ts).
 *
 * Every site publishes through its organization's build engine and hosting
 * (customer publishing). Typeroll no longer builds sites itself: a site still
 * in the former managed mode fails with a named error until it is migrated.
 */
export async function executeDeployJob(args: EnqueueArgs): Promise<DeployRunOutcome> {
  const store = getStore();
  const site = await store.getDoc<{ publishing_mode?: string }>(paths.site(args.orgId, args.siteId));
  const jobPath = paths.deploy(args.orgId, args.siteId, args.jobId);
  // A verification retry of a publication that already ran on customer
  // publishing resumes there even if the site's mode was changed since.
  const retry = site?.publishing_mode !== 'customer_git' && (await store.getDoc<{ verification_retry?: unknown }>(jobPath))?.verification_retry;
  if (site?.publishing_mode === 'customer_git' || retry) {
    const { executeCustomerPublication } = await import('../publishing/customer-runner');
    return executeCustomerPublication(args);
  }
  await store.compareAndUpdateDoc(jobPath, job => ['queued', 'running'].includes(String((job as { status?: unknown }).status)), {
    status: 'failed', phase: 'failed', finished_at: new Date().toISOString(),
    error: MANAGED_PUBLISHING_REMOVED.message, failure: { code: MANAGED_PUBLISHING_REMOVED.code },
  }).catch(() => { /* the job document is gone; nothing to report on */ });
  return 'ran';
}

let cached: DeployQueue | null = null;

export function getDeployQueue(): DeployQueue {
  return cached ??= new ScheduledDeployQueue();
}
