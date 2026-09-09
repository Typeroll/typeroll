import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { getStore } from '../../lib/datastore';
import { verifyStaticBatch } from '../../lib/builds/publication';

const mocked = vi.hoisted(() => ({ checks: [] as any[], verify: vi.fn() }));
vi.mock('../../lib/builds/storage', () => ({ buildStorage: async (_org: string, work: any) => work({ read: async () => Buffer.from(JSON.stringify(mocked.checks)) }) }));
vi.mock('../../lib/builds/verification', async original => ({ ...await original<object>(), verifyStaticResponse: mocked.verify }));
const job = 'organizations/org/sites/site/deploys/job';
const inspect = async () => (await getStore().listDocs(`${job}/build_verifications`))[0];
const check = () => verifyStaticBatch('org', job, 'builds/org/checks/frozen.json', 'https://site.example.com');

beforeEach(async () => {
  makeTmpFixtures(); await resetDatastore(); vi.clearAllMocks();
  mocked.checks = Array.from({ length: 14 }, (_, i) => ({ route: `/page-${i}/`, status: 200, sha256: 'a'.repeat(64) }));
  mocked.verify.mockResolvedValue(true);
});
afterEach(() => vi.restoreAllMocks());

it('verifies a healthy small publication in one observation', async () => {
  expect(await check()).toBe(true);
  expect(mocked.verify).toHaveBeenCalledTimes(14);
  expect(await inspect()).toMatchObject({ cursor: 14, complete: true });
});

it('resets progress when later response bytes or a deleted route disagree', async () => {
  mocked.checks[10] = { route: '/removed/', status: 404 };
  mocked.verify.mockImplementation(async (_origin, item) => item.route !== '/removed/');
  expect(await check()).toBe(false);
  expect(await inspect()).toMatchObject({ cursor: 0, complete: false });
  mocked.verify.mockResolvedValue(true);
  expect(await check()).toBe(true);
});

it('bounds large publications and resumes the persisted cursor', async () => {
  mocked.checks = Array.from({ length: 130 }, (_, i) => ({ route: `/page-${i}/`, status: 200 }));
  expect(await check()).toBe(false);
  expect(await inspect()).toMatchObject({ cursor: 64, complete: false });
  expect(await check()).toBe(false);
  expect(await inspect()).toMatchObject({ cursor: 128, complete: false });
  expect(await check()).toBe(true);
  expect(mocked.verify).toHaveBeenCalledTimes(130);
});

it('yields after the time budget while retaining verified progress', async () => {
  let now = 0; vi.spyOn(Date, 'now').mockImplementation(() => now);
  mocked.verify.mockImplementation(async () => { now += 3000; return true; });
  expect(await check()).toBe(false);
  expect(await inspect()).toMatchObject({ cursor: 8, complete: false });
  mocked.verify.mockResolvedValue(true);
  expect(await check()).toBe(true);
  expect(mocked.verify).toHaveBeenCalledTimes(14);
});
