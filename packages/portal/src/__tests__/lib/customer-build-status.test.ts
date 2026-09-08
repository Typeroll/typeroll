import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { paths } from '@typeroll/shared';
import { getStore } from '../../lib/datastore';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { connectionPath } from '../../lib/publishing/connections';
import { customerBuildStatus } from '../../lib/publishing/build-status';

const provider = vi.hoisted(() => vi.fn());
vi.mock('../../lib/publishing/cloudflare-oauth', () => ({ cloudflareClient: async () => provider }));
const project = 'typeroll-1234567890abcdef';
beforeEach(async () => {
  makeTmpFixtures(); await resetDatastore(); vi.clearAllMocks();
  await getStore().setDoc(connectionPath('org', 'cloudflare'), { cloudflare: { account_id: 'a'.repeat(32) } });
  await getStore().setDoc(paths.deploy('org', 'site', 'job'), { status: 'failed', phase: 'failed', git_publication: {
    account_id: 'a'.repeat(32), owner: 'Synthetic', repo: project, project, commit: 'b'.repeat(40), branch: 'main',
  } });
  const deployment = { id: 'exact', project_name: project, environment: 'production',
    deployment_trigger: { metadata: { commit_hash: 'b'.repeat(40), branch: 'main' } },
    latest_stage: { name: 'deploy', status: 'success' }, stages: [{ name: 'build', status: 'success', started_on: '2026-09-08T00:00:00Z', ended_on: '2026-09-08T00:00:09Z' }],
    deployment_configs: { env_vars: { SECRET: { value: 'never-return-this' } } } };
  provider.mockImplementation(async route => route.includes('/deployments?') ? [{ ...deployment, deployment_trigger: { metadata: { commit_hash: 'c'.repeat(40) } } }, deployment]
    : route.endsWith('/deployments/exact') ? deployment : { uses_functions: false, secret: 'never-return-this' });
});
afterEach(() => vi.restoreAllMocks());

it('reads the exact deployment details without exposing any provider configuration or secrets', async () => {
  const result = await customerBuildStatus('org', 'site', 'job');
  expect(result.deployment).toMatchObject({ id: 'exact', commit: 'b'.repeat(40), latest_stage: { status: 'success' }, uses_functions: null });
  expect(result.project.uses_functions).toBe(false);
  expect(JSON.stringify(result)).not.toContain('never-return-this');
  expect(result.deployment?.stages).toHaveLength(1);
});

it('does not cross organization, site or changed Cloudflare account boundaries', async () => {
  await expect(customerBuildStatus('other', 'site', 'job')).rejects.toMatchObject({ status: 404 });
  await expect(customerBuildStatus('org', 'other', 'job')).rejects.toMatchObject({ status: 404 });
  await getStore().updateDoc(connectionPath('org', 'cloudflare'), { cloudflare: { account_id: 'c'.repeat(32) } });
  await expect(customerBuildStatus('org', 'site', 'job')).rejects.toMatchObject({ status: 409 });
  expect(provider).not.toHaveBeenCalled();
});
