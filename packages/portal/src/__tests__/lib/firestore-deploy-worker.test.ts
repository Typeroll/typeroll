import { beforeEach, describe, expect, it, vi } from 'vitest';

import { paths } from '@typeroll/shared';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import {
  FIRESTORE_DEPLOY_QUEUE_PATH,
  FirestoreDeployQueue,
  firestoreDeployQueueItemId,
  type EnqueueArgs,
  type FirestoreDeployQueueItem,
} from '../../lib/deploy/queue';
import { FirestoreDeployWorker } from '../../lib/deploy/firestore-worker';

const args: EnqueueArgs = {
  jobId: 'job-one',
  orgId: 'org-one',
  siteId: 'site-one',
  versionId: 'main',
  environment: 'production',
  dryRun: true,
};

async function setup() {
  makeTmpFixtures();
  await resetDatastore();
  const { getStore } = await import('../../lib/datastore');
  const store = getStore();
  await store.setDoc(paths.deploy(args.orgId, args.siteId, args.jobId), {
    version_id: args.versionId,
    environment: args.environment,
    status: 'queued',
    started_at: '2026-09-01T10:00:00.000Z',
  });
  return store;
}

describe('Firestore deploy queue worker', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    await resetDatastore();
  });

  it('persists an accepted deploy before returning to the portal', async () => {
    const store = await setup();
    await new FirestoreDeployQueue(store).enqueue(args);

    const id = firestoreDeployQueueItemId(args);
    const item = await store.getDoc<FirestoreDeployQueueItem>(`${FIRESTORE_DEPLOY_QUEUE_PATH}/${id}`);
    expect(item).toMatchObject({ ...args, status: 'queued', attempts: 0 });
    expect(item?.created_at).toBeTruthy();
    expect(item?.available_at).toBe(item?.created_at);
  });

  it('does not overwrite an existing lease when enqueue is retried', async () => {
    const store = await setup();
    const queue = new FirestoreDeployQueue(store);
    await queue.enqueue(args);
    const id = firestoreDeployQueueItemId(args);
    const itemPath = `${FIRESTORE_DEPLOY_QUEUE_PATH}/${id}`;
    await store.updateDoc(itemPath, {
      status: 'leased',
      attempts: 2,
      lease_owner: 'active-worker',
      lease_expires_at: '2026-09-02T00:00:00.000Z',
    });

    await queue.enqueue(args);

    expect(await store.getDoc<FirestoreDeployQueueItem>(itemPath)).toMatchObject({
      status: 'leased',
      attempts: 2,
      lease_owner: 'active-worker',
    });
  });

  it('leases one queue item atomically and consumes it after execution', async () => {
    const store = await setup();
    await new FirestoreDeployQueue(store).enqueue(args);
    const execute = vi.fn(async (_args: EnqueueArgs) => 'ran' as const);
    const now = () => new Date('2026-09-01T23:01:00.000Z');
    const first = new FirestoreDeployWorker({ store, execute, workerId: 'worker-a', now });
    const second = new FirestoreDeployWorker({ store, execute, workerId: 'worker-b', now });

    expect(await first.tick()).toMatchObject({ leased: 1, completed: 1 });
    expect(await second.tick()).toMatchObject({ leased: 0, completed: 0 });
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]?.[0]).toEqual(args);
    expect(await store.listDocs(FIRESTORE_DEPLOY_QUEUE_PATH)).toEqual([]);
  });

  it('recovers a running job after its previous worker lease expired', async () => {
    const store = await setup();
    const id = firestoreDeployQueueItemId(args);
    await store.setDoc(`${FIRESTORE_DEPLOY_QUEUE_PATH}/${id}`, {
      ...args,
      status: 'leased',
      created_at: '2026-09-01T09:00:00.000Z',
      available_at: '2026-09-01T09:00:00.000Z',
      attempts: 1,
      lease_owner: 'dead-worker',
      lease_expires_at: '2026-09-01T09:30:00.000Z',
    } satisfies FirestoreDeployQueueItem);
    await store.updateDoc(paths.deploy(args.orgId, args.siteId, args.jobId), { status: 'running' });
    const execute = vi.fn(async (_args: EnqueueArgs) => {
      const job = await store.getDoc<{ status: string; phase?: string }>(paths.deploy(args.orgId, args.siteId, args.jobId));
      expect(job?.status).toBe('queued');
      expect(job?.phase).toBe('recovered_after_worker_lease_expiry');
      return 'ran' as const;
    });
    const worker = new FirestoreDeployWorker({
      store,
      execute,
      workerId: 'worker-recovery',
      now: () => new Date('2026-09-01T10:00:00.000Z'),
    });

    expect(await worker.tick()).toMatchObject({ leased: 1, completed: 1 });
    expect(execute).toHaveBeenCalledOnce();
  });

  it('renews the lease while a long deploy is still executing', async () => {
    const store = await setup();
    await new FirestoreDeployQueue(store).enqueue(args);
    let current = new Date('2026-09-01T23:01:00.000Z');
    const id = firestoreDeployQueueItemId(args);
    const execute = vi.fn(async (_args: EnqueueArgs) => {
      current = new Date('2026-09-01T23:01:25.000Z');
      await new Promise((resolve) => setTimeout(resolve, 10));
      const item = await store.getDoc<FirestoreDeployQueueItem>(`${FIRESTORE_DEPLOY_QUEUE_PATH}/${id}`);
      expect(item?.lease_expires_at).toBe('2026-09-01T23:02:25.000Z');
      return 'ran' as const;
    });
    const worker = new FirestoreDeployWorker({
      store,
      execute,
      workerId: 'worker-heartbeat',
      now: () => current,
      leaseMs: 60_000,
      heartbeatMs: 1,
    });

    expect(await worker.tick()).toMatchObject({ leased: 1, completed: 1 });
    expect(execute).toHaveBeenCalledOnce();
  });

  it('fails the deploy safely after exhausting worker attempts', async () => {
    const store = await setup();
    await new FirestoreDeployQueue(store).enqueue(args);
    const execute = vi.fn(async (_args: EnqueueArgs) => {
      throw new Error('credential detail that must not be copied to the job');
    });
    const worker = new FirestoreDeployWorker({
      store,
      execute,
      workerId: 'worker-failing',
      now: () => new Date('2026-09-01T23:01:00.000Z'),
      maxAttempts: 1,
    });

    expect(await worker.tick()).toMatchObject({ leased: 1, failed: 1 });
    const job = await store.getDoc(paths.deploy(args.orgId, args.siteId, args.jobId));
    expect(job).toMatchObject({ status: 'failed', phase: 'worker_attempts_exhausted' });
    expect(JSON.stringify(job)).not.toContain('credential detail');
    const queue = await store.listDocs<FirestoreDeployQueueItem>(FIRESTORE_DEPLOY_QUEUE_PATH);
    expect(queue).toEqual([]);
    expect(JSON.stringify(queue)).not.toContain('credential detail');
  });
});
