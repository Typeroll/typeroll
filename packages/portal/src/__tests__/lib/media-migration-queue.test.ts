import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ createTask: vi.fn(), close: vi.fn(), execute: vi.fn(), auth: vi.fn() }));
vi.mock('@google-cloud/tasks', () => ({ CloudTasksClient: class { createTask = mocks.createTask; close = mocks.close; } }));
vi.mock('../../lib/publishing/media-migration', () => ({ executeMediaMigration: mocks.execute }));
vi.mock('../../lib/internal-auth', () => ({ verifyInternalOidc: mocks.auth }));
import { enqueueMediaMigration } from '../../lib/publishing/media-migration-queue';
import { CHAIN_FLOOR_MS } from '../../lib/scheduling/chain';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { POST } from '../../pages/api/internal/deploy-worker';

beforeEach(async () => {
  makeTmpFixtures(); await resetDatastore();
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

const sent = () => mocks.createTask.mock.calls.map(([input]) => input.task);
const payload = (task: any) => JSON.parse(Buffer.from(task.httpRequest.body, 'base64').toString());

it('joins one chain per organization instead of adding a delivery per request', async () => {
  await enqueueMediaMigration('org'); await enqueueMediaMigration('org'); await enqueueMediaMigration('org', 60_000);
  expect(sent()).toHaveLength(1);
  const [first] = sent();
  expect(first.scheduleTime).toBeUndefined();
  expect(first.httpRequest.oidcToken).toEqual({ serviceAccountEmail: 'worker@test.invalid', audience: 'https://worker.example.com/api/internal/deploy-worker' });
  expect(payload(first)).toEqual({ kind: 'media_migration', orgId: 'org', generation: 1 });
  await enqueueMediaMigration('org', 0, 'site');
  expect(payload(sent()[1])).toEqual({ kind: 'media_migration', orgId: 'org', siteId: 'site', generation: 1 });
});

it('continues the chain with a floor between deliveries and stops when the work is done', async () => {
  await enqueueMediaMigration('org');
  mocks.execute.mockResolvedValue(0);
  expect((await run({ kind: 'media_migration', orgId: 'org', generation: 1 })).status).toBe(200);
  expect(mocks.execute).toHaveBeenCalledExactlyOnceWith('org', undefined);
  const next = sent()[1];
  expect(payload(next)).toEqual({ kind: 'media_migration', orgId: 'org', generation: 2 });
  expect(next.scheduleTime.seconds).toBeGreaterThanOrEqual(Math.floor((Date.now() + CHAIN_FLOOR_MS) / 1000) - 1);
  mocks.execute.mockResolvedValue(null);
  expect((await run({ kind: 'media_migration', orgId: 'org', generation: 2 })).status).toBe(200);
  expect(sent()).toHaveLength(2);
});

it('drops a superseded or duplicated delivery without running the work', async () => {
  await enqueueMediaMigration('org');
  mocks.execute.mockResolvedValue(null);
  expect((await run({ kind: 'media_migration', orgId: 'org', generation: 1 })).status).toBe(200);
  expect((await run({ kind: 'media_migration', orgId: 'org', generation: 1 })).status).toBe(200);
  expect(mocks.execute).toHaveBeenCalledOnce();
});

it('marks a running chain to run again instead of starting a second one', async () => {
  await enqueueMediaMigration('org');
  let release!: () => void;
  mocks.execute.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve(null); }));
  const delivery = run({ kind: 'media_migration', orgId: 'org', generation: 1 });
  await vi.waitFor(() => expect(mocks.execute).toHaveBeenCalledOnce());
  await enqueueMediaMigration('org'); await enqueueMediaMigration('org');
  expect(sent()).toHaveLength(1);
  release();
  expect((await delivery).status).toBe(200);
  expect(sent()).toHaveLength(2);
  expect(payload(sent()[1])).toMatchObject({ generation: 2 });
});

it('folds a delivery queued before chains existed into the chain', async () => {
  expect((await run({ kind: 'media_migration', orgId: 'org', siteId: 'site' })).status).toBe(200);
  expect(mocks.execute).not.toHaveBeenCalled();
  expect(payload(sent()[0])).toEqual({ kind: 'media_migration', orgId: 'org', siteId: 'site', generation: 1 });
  expect((await run({ kind: 'media_migration', orgId: 'org', siteId: '../other' })).status).toBe(400);
});

it('hands a queue outage back for retry and lets the next request restart the chain', async () => {
  await enqueueMediaMigration('org');
  mocks.execute.mockResolvedValue(0); mocks.createTask.mockRejectedValueOnce(new Error('Unavailable'));
  expect((await run({ kind: 'media_migration', orgId: 'org', generation: 1 })).status).toBe(503);
  await enqueueMediaMigration('org');
  expect(payload(sent().at(-1))).toMatchObject({ generation: 3 });
});

it('rejects unauthenticated and malformed media tasks before accessing an organization', async () => {
  mocks.auth.mockResolvedValue(false);
  expect((await run({ kind: 'media_migration', orgId: 'org' })).status).toBe(401);
  mocks.auth.mockResolvedValue(true);
  expect((await run({ kind: 'media_migration', orgId: '../../other' })).status).toBe(400);
  expect(mocks.execute).not.toHaveBeenCalled();
});

it('uses the persisted job for portable workers and one local chain for development', async () => {
  vi.stubEnv('DEPLOY_QUEUE', 'firestore');
  await enqueueMediaMigration('org');
  expect(mocks.execute).not.toHaveBeenCalled(); expect(mocks.createTask).not.toHaveBeenCalled();
  vi.stubEnv('DEPLOY_QUEUE', 'in_process');
  mocks.execute.mockResolvedValue(null);
  await enqueueMediaMigration('org'); await enqueueMediaMigration('org');
  await vi.waitFor(() => expect(mocks.execute).toHaveBeenCalledOnce());
  await new Promise(resolve => setTimeout(resolve, 200));
  expect(mocks.execute).toHaveBeenCalledOnce();
});
