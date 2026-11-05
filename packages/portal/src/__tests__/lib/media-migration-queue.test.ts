import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('../../lib/publishing/media-migration', () => ({ executeMediaMigration: mocks.execute }));
import { enqueueMediaMigration, mediaChainSource } from '../../lib/publishing/media-migration-queue';
import { CHAIN_FLOOR_MS } from '../../lib/scheduling/chain';
import { workPath, type ScheduledWork } from '../../lib/scheduling/index';
import { executeScheduledWork } from '../../lib/scheduling/worker';
import { _clearLocalDeliveries } from '../../lib/scheduling/transport';
import { getStore } from '../../lib/datastore';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';

const orgPath = workPath(mediaChainSource('org'), 'media_chain');
const id = (path: string) => path.split('/').pop()!;
const entry = (path = orgPath) => getStore().getDoc<ScheduledWork>(path);
// Deliveries run when due: after the chain floor at the latest.
const deliver = async (generation: string, path = orgPath) => executeScheduledWork(id(path), generation, new Date(Date.now() + CHAIN_FLOOR_MS + 1_000));

beforeEach(async () => { makeTmpFixtures(); await resetDatastore(); vi.resetAllMocks(); });
afterEach(() => { vi.unstubAllEnvs(); _clearLocalDeliveries(); });

it('joins one chain per organization instead of adding a delivery per request', async () => {
  await enqueueMediaMigration('org'); await enqueueMediaMigration('org'); await enqueueMediaMigration('org', 60_000);
  const first = await entry();
  expect(first).toMatchObject({ kind: 'media_chain', source: 'organizations/org', generation: '1', payload: { org_id: 'org', site_id: null } });
  expect(first!.due_at).toBeLessThanOrEqual(Date.now());
  await enqueueMediaMigration('org', 0, 'site');
  expect(await entry(workPath(mediaChainSource('org', 'site'), 'media_chain'))).toMatchObject({ source: 'organizations/org/sites/site', generation: '1', payload: { site_id: 'site' } });
  expect(await entry()).toEqual(first);
});

it('continues the chain with a floor between deliveries and stops when the work is done', async () => {
  await enqueueMediaMigration('org');
  mocks.execute.mockResolvedValue(0);
  await deliver('1');
  expect(mocks.execute).toHaveBeenCalledExactlyOnceWith('org', undefined);
  const next = await entry();
  expect(next).toMatchObject({ generation: '2' });
  expect(next!.due_at).toBeGreaterThanOrEqual(Date.now() + CHAIN_FLOOR_MS - 1_000);
  mocks.execute.mockResolvedValue(null);
  await deliver('2');
  expect(await entry()).toMatchObject({ generation: '2', due_at: Number.MAX_SAFE_INTEGER });
});

it('drops a superseded or duplicated delivery without running the work', async () => {
  await enqueueMediaMigration('org');
  mocks.execute.mockResolvedValue(null);
  await deliver('1'); await deliver('1'); await deliver('0');
  expect(mocks.execute).toHaveBeenCalledOnce();
});

it('marks a running chain to run again instead of starting a second one', async () => {
  await enqueueMediaMigration('org');
  let release!: () => void;
  mocks.execute.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve(null); }));
  const delivery = deliver('1');
  await vi.waitFor(() => expect(mocks.execute).toHaveBeenCalledOnce());
  await enqueueMediaMigration('org'); await enqueueMediaMigration('org');
  expect(await entry()).toMatchObject({ generation: '1' });
  release();
  await delivery;
  expect(await entry()).toMatchObject({ generation: '2' });
});

it('hands a failed delivery back for retry without starting a second chain', async () => {
  await enqueueMediaMigration('org');
  mocks.execute.mockRejectedValueOnce(new Error('synthetic outage')).mockResolvedValueOnce(null);
  await expect(deliver('1')).rejects.toThrow('synthetic outage');
  expect(await entry()).toMatchObject({ generation: '1', lease_until: 0 });
  await deliver('1');
  expect(mocks.execute).toHaveBeenCalledTimes(2);
  expect(await entry()).toMatchObject({ generation: '1', due_at: Number.MAX_SAFE_INTEGER });
});

it('delivers one local chain in development', async () => {
  vi.stubEnv('TYPEROLL_SCHEDULER', 'local');
  mocks.execute.mockResolvedValue(null);
  await enqueueMediaMigration('org'); await enqueueMediaMigration('org');
  await vi.waitFor(() => expect(mocks.execute).toHaveBeenCalledOnce());
  await new Promise(resolve => setTimeout(resolve, 200));
  expect(mocks.execute).toHaveBeenCalledOnce();
});
