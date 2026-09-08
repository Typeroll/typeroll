import { beforeEach, expect, it, vi } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { getStore } from '../../lib/datastore';
import { CloudTasksQueue, FirestoreDeployQueue, FIRESTORE_DEPLOY_QUEUE_PATH } from '../../lib/deploy/queue';
const mocks = vi.hoisted(() => ({ createTask: vi.fn(), close: vi.fn() }));
vi.mock('@google-cloud/tasks', () => ({ CloudTasksClient: class { createTask = mocks.createTask; close = mocks.close; } }));
vi.mock('../../lib/publishing/readiness', () => ({ assertPublishingReady: async () => ({ ready: true }) }));
const args = { orgId: 'org', siteId: 'site', jobId: 'job', versionId: 'main', environment: 'production' as const };
beforeEach(async () => {
  makeTmpFixtures(); await resetDatastore(); vi.clearAllMocks(); mocks.createTask.mockResolvedValue([]);
});
it('Cloud Tasks accepts an idempotent continuation without colliding with the original task', async () => {
  const queue = new CloudTasksQueue('projects/synthetic/locations/test/queues/deploy', 'https://cms.example.com/api/internal/deploy-worker', 'synthetic@example.com');
  await queue.enqueue(args);
  await queue.enqueue({ ...args, dispatchKey: 'a'.repeat(16) });
  expect(mocks.createTask.mock.calls[0][0].task.name).not.toBe(mocks.createTask.mock.calls[1][0].task.name);
  mocks.createTask.mockRejectedValueOnce({ code: 6 });
  await expect(queue.enqueue({ ...args, dispatchKey: 'a'.repeat(16) })).resolves.toBeUndefined();
  expect(mocks.createTask.mock.calls[1][0].task.name).toBe(mocks.createTask.mock.calls[2][0].task.name);
  mocks.createTask.mockRejectedValueOnce({ code: 7 });
  await expect(queue.enqueue(args)).rejects.toEqual({ code: 7 });
  expect(mocks.close).toHaveBeenCalledTimes(4);
});
it('Firestore separates the continuation while deduplicating repeated approval delivery', async () => {
  const queue = new FirestoreDeployQueue();
  await queue.enqueue(args);
  await queue.enqueue({ ...args, dispatchKey: 'a'.repeat(16) });
  await queue.enqueue({ ...args, dispatchKey: 'a'.repeat(16) });
  const queued = await getStore().listDocs<any>(FIRESTORE_DEPLOY_QUEUE_PATH);
  expect(queued).toHaveLength(2);
  expect(queued.every(item => item.jobId === 'job')).toBe(true);
});
