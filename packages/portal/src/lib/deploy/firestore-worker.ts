import { randomUUID } from 'node:crypto';

import type { DeployEnvironment, DeployJob } from '@typeroll/shared';
import { paths } from '@typeroll/shared';
import { getStore, type ReadWriteStore } from '../datastore';
import { runPublishSweep } from '../scheduled-publish';
import { slotWaitMs } from './concurrency';
import {
  executeDeployJob,
  FIRESTORE_DEPLOY_QUEUE_PATH,
  type DeployRunOutcome,
  type EnqueueArgs,
  type FirestoreDeployQueueItem,
} from './queue';

const DEFAULT_POLL_MS = 2_000;
const DEFAULT_LEASE_MS = 30 * 60 * 1_000;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_SWEEP_MS = 60_000;

type Execute = (args: EnqueueArgs, opts?: { slotWaitMs?: number }) => Promise<DeployRunOutcome>;

export interface WorkerTickResult {
  leased: number;
  completed: number;
  deferred: number;
  failed: number;
}

interface WorkerOptions {
  store?: ReadWriteStore;
  execute?: Execute;
  workerId?: string;
  now?: () => Date;
  leaseMs?: number;
  heartbeatMs?: number;
  maxAttempts?: number;
}

function numberFromEnv(value: string | undefined, fallback: number, minimum: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= minimum ? Math.floor(parsed) : fallback;
}

function queueItemPath(id: string): string {
  return `${FIRESTORE_DEPLOY_QUEUE_PATH}/${id}`;
}

function isLeaseable(item: FirestoreDeployQueueItem, nowIso: string): boolean {
  if (item.status === 'queued') return !item.available_at || item.available_at <= nowIso;
  return item.status === 'leased' && Boolean(item.lease_expires_at && item.lease_expires_at <= nowIso);
}

function payload(item: FirestoreDeployQueueItem & { id: string }): EnqueueArgs {
  return {
    jobId: item.jobId,
    orgId: item.orgId,
    siteId: item.siteId,
    versionId: item.versionId,
    environment: item.environment as DeployEnvironment,
    dryRun: item.dryRun === true,
  };
}

export class FirestoreDeployWorker {
  private readonly store: ReadWriteStore;
  private readonly execute: Execute;
  private readonly workerId: string;
  private readonly now: () => Date;
  private readonly leaseMs: number;
  private readonly heartbeatMs: number;
  private readonly maxAttempts: number;

  constructor(options: WorkerOptions = {}) {
    this.store = options.store ?? getStore();
    this.execute = options.execute ?? executeDeployJob;
    this.workerId = options.workerId ?? randomUUID();
    this.now = options.now ?? (() => new Date());
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    this.heartbeatMs = options.heartbeatMs ?? Math.max(10_000, Math.floor(this.leaseMs / 3));
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  }

  async tick(): Promise<WorkerTickResult> {
    const result: WorkerTickResult = { leased: 0, completed: 0, deferred: 0, failed: 0 };
    const now = this.now();
    const nowIso = now.toISOString();
    const candidates = await this.store.listDocs<FirestoreDeployQueueItem>(FIRESTORE_DEPLOY_QUEUE_PATH, {
      filters: [{ field: 'status', op: 'in', value: ['queued', 'leased'] }],
      limit: 50,
    });
    candidates.sort((left, right) => left.created_at.localeCompare(right.created_at));

    for (const candidate of candidates) {
      if (!isLeaseable(candidate, nowIso)) continue;
      const attempts = (candidate.attempts ?? 0) + 1;
      const leased = await this.store.compareAndUpdateDoc<FirestoreDeployQueueItem>(
        queueItemPath(candidate.id),
        (current) => isLeaseable(current, nowIso),
        {
          status: 'leased',
          lease_owner: this.workerId,
          lease_expires_at: new Date(now.valueOf() + this.leaseMs).toISOString(),
          attempts,
        },
      );
      if (!leased) continue;
      result.leased += 1;
      const stopHeartbeat = this.startLeaseHeartbeat(candidate.id);

      try {
        const jobPath = paths.deploy(candidate.orgId, candidate.siteId, candidate.jobId);
        const job = await this.store.getDoc<DeployJob>(jobPath);
        if (!job || job.status === 'succeeded' || job.status === 'failed') {
          await this.store.deleteDoc(queueItemPath(candidate.id));
          result.completed += 1;
          continue;
        }
        if (job.status === 'running') {
          await this.store.updateDoc(jobPath, {
            status: 'queued',
            phase: 'recovered_after_worker_lease_expiry',
          });
        }

        try {
          const outcome = await this.execute(payload(candidate), { slotWaitMs: slotWaitMs() });
          if (outcome === 'deferred') {
            await this.requeue(candidate.id, attempts, 'no build slot available');
            result.deferred += 1;
          } else {
            await this.store.deleteDoc(queueItemPath(candidate.id));
            result.completed += 1;
          }
        } catch {
          // Queue documents are operator-visible. Do not persist raw exception
          // text because SDK errors can contain credential or request details.
          const message = 'worker execution failed';
          if (attempts >= this.maxAttempts) {
            await this.store.updateDoc(jobPath, {
              status: 'failed',
              phase: 'worker_attempts_exhausted',
              finished_at: this.now().toISOString(),
              error: 'Deploy worker could not execute the queued job.',
            });
            await this.store.deleteDoc(queueItemPath(candidate.id));
            result.failed += 1;
          } else {
            await this.requeue(candidate.id, attempts, message);
            result.deferred += 1;
          }
        }
      } finally {
        stopHeartbeat();
      }
    }

    return result;
  }

  private async requeue(id: string, attempts: number, error: string): Promise<void> {
    const backoffMs = Math.min(60_000, 1_000 * (2 ** Math.max(0, attempts - 1)));
    await this.store.updateDoc(queueItemPath(id), {
      status: 'queued',
      available_at: new Date(this.now().valueOf() + backoffMs).toISOString(),
      lease_owner: null,
      lease_expires_at: null,
      last_error: error,
    });
  }

  private startLeaseHeartbeat(id: string): () => void {
    const timer = setInterval(() => {
      void this.store.compareAndUpdateDoc<FirestoreDeployQueueItem>(
        queueItemPath(id),
        (current) => current.status === 'leased' && current.lease_owner === this.workerId,
        { lease_expires_at: new Date(this.now().valueOf() + this.leaseMs).toISOString() },
      ).catch(() => {
        console.error('[firestore-worker] lease heartbeat failed');
      });
    }, this.heartbeatMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }
}

let loopStarted = false;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/** Start the worker once for this process. The HTTP server keeps the process
 * alive; this loop owns durable deploy execution and scheduled publishing. */
export function ensureFirestoreWorkerLoop(): void {
  if (loopStarted) return;
  loopStarted = true;
  const pollMs = numberFromEnv(process.env.DEPLOY_WORKER_POLL_MS, DEFAULT_POLL_MS, 250);
  const sweepMs = numberFromEnv(process.env.PUBLISH_SWEEP_INTERVAL_MS, DEFAULT_SWEEP_MS, 10_000);
  const worker = new FirestoreDeployWorker({
    leaseMs: numberFromEnv(process.env.DEPLOY_WORKER_LEASE_MS, DEFAULT_LEASE_MS, 60_000),
    maxAttempts: numberFromEnv(process.env.DEPLOY_WORKER_MAX_ATTEMPTS, DEFAULT_MAX_ATTEMPTS, 1),
  });

  void (async () => {
    let nextSweep = 0;
    for (;;) {
      try {
        const result = await worker.tick();
        if (result.leased > 0) console.log(`[firestore-worker] ${JSON.stringify(result)}`);
      } catch {
        console.error('[firestore-worker] poll failed');
      }

      if (Date.now() >= nextSweep) {
        nextSweep = Date.now() + sweepMs;
        try {
          const sweep = await runPublishSweep();
          const changed = sweep.pages_published + sweep.pages_unpublished + sweep.items_published + sweep.items_unpublished;
          if (changed > 0 || sweep.errors.length > 0) {
            console.log(`[publish-sweep] ${JSON.stringify({
              pages_published: sweep.pages_published,
              pages_unpublished: sweep.pages_unpublished,
              items_published: sweep.items_published,
              items_unpublished: sweep.items_unpublished,
              error_count: sweep.errors.length,
            })}`);
          }
        } catch {
          console.error('[publish-sweep] failed');
        }
      }

      await delay(pollMs);
    }
  })();
}
