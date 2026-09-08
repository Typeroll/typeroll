import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { paths } from '@typeroll/shared';
import { getStore } from '../../lib/datastore';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { recordCustomerCompute } from '../../lib/publishing/compute-cost';

beforeEach(async () => {
  makeTmpFixtures(); await resetDatastore();
  await getStore().setDoc(paths.deploy('org', 'site', 'job'), { status: 'running' });
});
afterEach(() => vi.unstubAllEnvs());

it('sums active attempts and request fees without charging for remote build waiting', async () => {
  await recordCustomerCompute('org', 'site', 'job', 1000);
  await recordCustomerCompute('org', 'site', 'job', 500);
  const job = await getStore().getDoc<any>(paths.deploy('org', 'site', 'job'));
  expect(job.cost).toMatchObject({ duration_s: 1.5, requests: 2, request: 0.0000008, estimated: true });
  expect(job.cost.total).toBe(0.00004055);
});

it('retains both concurrent attempts and freezes the original rate card', async () => {
  await recordCustomerCompute('org', 'site', 'job', 1000);
  vi.stubEnv('DEPLOY_COST_VCPU', '100');
  await Promise.all([recordCustomerCompute('org', 'site', 'job', 1000), recordCustomerCompute('org', 'site', 'job', 1000)]);
  expect((await getStore().getDoc<any>(paths.deploy('org', 'site', 'job'))).cost).toMatchObject({ duration_s: 3, requests: 3, vcpu: 1 });
});

it('does not recreate a deployment removed during execution', async () => {
  await recordCustomerCompute('org', 'other', 'deleted', 1000);
  expect(await getStore().getDoc(paths.deploy('org', 'other', 'deleted'))).toBeNull();
});
