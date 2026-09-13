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
  await getStore().setDoc(job, { status: 'running' });
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
  mocked.checks = Array.from({ length: 2135 }, (_, i) => ({ route: `/media/image-${i}.avif`, status: 200 }));
  expect(await check()).toBe(false);
  expect(await inspect()).toMatchObject({ cursor: 1024, complete: false });
  expect(await check()).toBe(false);
  expect(await inspect()).toMatchObject({ cursor: 2048, complete: false });
  expect(await check()).toBe(true);
  expect(mocked.verify).toHaveBeenCalledTimes(2135);
});

it('keeps verification concurrency bounded while draining a large healthy batch', async () => {
  mocked.checks = Array.from({ length: 1001 }, (_, i) => ({ route: `/media/${i}.webp`, status: 200 }));
  let active = 0, peak = 0;
  mocked.verify.mockImplementation(async () => {
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 1));
    active--; return true;
  });
  expect(await check()).toBe(true);
  expect(await inspect()).toMatchObject({ cursor: 1001, complete: true });
  expect(peak).toBe(8);
  expect(active).toBe(0);
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

it('records the failed route and response status without any response body', async () => {
  mocked.checks = [{ route: '/removed/', status: 404 }];
  mocked.verify.mockImplementation(async (_origin, _check, options) => {
    options.observe({ route: '/removed/', expected_status: 404, actual_status: 200, reason: 'status_mismatch', cf_ray: 'a38654d0f853c124-ARN' });
    return false;
  });
  expect(await check()).toBe(false);
  expect(await getStore().getDoc(job)).toMatchObject({ static_probe: { origin: 'https://site.example.com', route: '/removed/', actual_status: 200, expected_status: 404 }, verification_message: expect.stringContaining('HTTP 200 at /removed/') });
  mocked.verify.mockResolvedValue(true);
  expect(await check()).toBe(true);
  expect(await getStore().getDoc(job)).toMatchObject({ static_probe: null, verification_message: null });
});
