import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ createTask: vi.fn(), close: vi.fn(), execute: vi.fn(), auth: vi.fn() }));
vi.mock('@google-cloud/tasks', () => ({ CloudTasksClient: class { createTask = mocks.createTask; close = mocks.close; } }));
vi.mock('../../lib/publishing/media-migration', () => ({ executeMediaMigration: mocks.execute }));
vi.mock('../../lib/internal-auth', () => ({ verifyInternalOidc: mocks.auth }));
import { enqueueMediaMigration } from '../../lib/publishing/media-migration-queue';
import { POST } from '../../pages/api/internal/deploy-worker';

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('DEPLOY_QUEUE', 'cloud_tasks');
  vi.stubEnv('CLOUD_TASKS_QUEUE', 'projects/test/locations/test/queues/deploy');
  vi.stubEnv('DEPLOY_WORKER_URL', 'https://worker.example.com/api/internal/deploy-worker');
  vi.stubEnv('CLOUD_TASKS_SERVICE_ACCOUNT', 'worker@test.invalid');
  vi.stubEnv('DEPLOY_WORKER_SKIP_AUTH', '0');
  mocks.auth.mockResolvedValue(true);
});
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });
const run = (body: unknown) => POST({ request: new Request('https://worker.example.com/api/internal/deploy-worker', {
  method: 'POST', body: JSON.stringify(body),
}) } as never) as Promise<Response>;

it('dispatches immediately with the existing signed transport and unique continuation identities', async () => {
  await enqueueMediaMigration('org'); await enqueueMediaMigration('org');
  const [first, second] = mocks.createTask.mock.calls.map(([input]) => input.task);
  expect(first.name).not.toBe(second.name);
  expect(first.scheduleTime).toBeUndefined();
  expect(first.httpRequest.oidcToken).toEqual({ serviceAccountEmail: 'worker@test.invalid', audience: 'https://worker.example.com/api/internal/deploy-worker' });
  expect(JSON.parse(Buffer.from(first.httpRequest.body, 'base64').toString())).toEqual({ kind: 'media_migration', orgId: 'org' });
  expect(mocks.close).toHaveBeenCalledTimes(2);
});

it('continues immediately on the authenticated worker without creating or publishing a site', async () => {
  mocks.execute.mockResolvedValue(0);
  expect((await run({ kind: 'media_migration', orgId: 'org' })).status).toBe(200);
  expect(mocks.execute).toHaveBeenCalledExactlyOnceWith('org');
  expect(mocks.createTask).toHaveBeenCalledOnce();
  mocks.execute.mockResolvedValue(null); mocks.createTask.mockClear();
  expect((await run({ kind: 'media_migration', orgId: 'org' })).status).toBe(200);
  expect(mocks.createTask).not.toHaveBeenCalled();
});

it('hands a queue outage back for retry instead of acknowledging unfinished migration work', async () => {
  mocks.execute.mockResolvedValue(0); mocks.createTask.mockRejectedValue(new Error('Unavailable'));
  expect((await run({ kind: 'media_migration', orgId: 'org' })).status).toBe(503);
  expect(mocks.close).toHaveBeenCalledOnce();
});

it('delays a transient retry without delaying successful batches', async () => {
  mocks.execute.mockResolvedValue(5000);
  const now = Date.now();
  await run({ kind: 'media_migration', orgId: 'org' });
  expect(mocks.createTask.mock.calls[0][0].task.scheduleTime.seconds).toBeGreaterThanOrEqual(Math.floor((now + 5000) / 1000));
});

it('rejects unauthenticated and malformed media tasks before accessing an organization', async () => {
  mocks.auth.mockResolvedValue(false);
  expect((await run({ kind: 'media_migration', orgId: 'org' })).status).toBe(401);
  mocks.auth.mockResolvedValue(true);
  expect((await run({ kind: 'media_migration', orgId: '../../other' })).status).toBe(400);
  expect(mocks.execute).not.toHaveBeenCalled();
});

it('uses the persisted job for portable workers and consecutive local tasks for development', async () => {
  vi.stubEnv('DEPLOY_QUEUE', 'firestore');
  await enqueueMediaMigration('org');
  expect(mocks.execute).not.toHaveBeenCalled(); expect(mocks.createTask).not.toHaveBeenCalled();
  vi.stubEnv('DEPLOY_QUEUE', 'in_process'); vi.useFakeTimers();
  mocks.execute.mockResolvedValueOnce(0).mockResolvedValueOnce(null);
  await enqueueMediaMigration('org'); await enqueueMediaMigration('org');
  await vi.runAllTimersAsync();
  expect(mocks.execute).toHaveBeenCalledTimes(2);
});
