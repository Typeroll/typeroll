import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { paths } from '@typeroll/shared';
import { getStore } from '../../lib/datastore';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { managedMigrationPlan, migrateManagedSite, verifyManagedProject } from '../../lib/publishing/managed-migration';
import { cloudflareClient } from '../../lib/publishing/cloudflare-oauth';
import { getConnection } from '../../lib/publishing/connections';
import { readEngineConfiguration } from '../../lib/builds/state';
import { prepareStaticProject } from '../../lib/builds/publication';
import { requestMediaMigration } from '../../lib/publishing/media-migration';
vi.mock('../../lib/publishing/cloudflare-oauth', () => ({ cloudflareClient: vi.fn() }));
vi.mock('../../lib/publishing/connections', async original => ({ ...await original<object>(), getConnection: vi.fn() }));
vi.mock('../../lib/publishing/hosting-groups', () => ({ siteHostingGroup: vi.fn(async () => ({ id: 'default' })) }));
vi.mock('../../lib/builds/selection', () => ({ selectedBuildProvider: vi.fn(async () => 'cloudflare') }));
vi.mock('../../lib/builds/state', () => ({ readEngineConfiguration: vi.fn() }));
vi.mock('../../lib/publishing/media-migration', () => ({ requestMediaMigration: vi.fn() }));
const account = 'a'.repeat(32);
const project = { name: 'existing-site', production_branch: 'main', domains: ['www.example.com'], source: null, canonical_deployment: { id: 'old-deploy', uses_functions: false } };
const provider = vi.fn();
beforeEach(async () => {
  vi.clearAllMocks(); makeTmpFixtures(); await resetDatastore(); vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', account);
  await getStore().setDoc(paths.site('org', 'site'), { name: 'Existing site', hosting_adapter: 'cloudflare', publishing_mode: 'managed', domain: 'www.example.com', hosting_config: { pages_project: 'existing-site' } });
  vi.mocked(getConnection).mockImplementation(async (_org, kind) => ({ status: 'connected', ...(kind === 'github' ? { github: { owner: 'connected-org' } } : { cloudflare: { account_id: account } }) }) as any);
  vi.mocked(readEngineConfiguration).mockResolvedValue({ status: 'ready' } as any);
  vi.mocked(cloudflareClient).mockResolvedValue(Object.assign(provider, { connectionRevision: 'connection-1' }));
  provider.mockResolvedValue(structuredClone(project));
});
afterEach(() => vi.unstubAllEnvs());
it('checks without writes and opts in only this site while retaining its previous deployment', async () => {
  await getStore().setDoc(paths.site('org', 'other'), { publishing_mode: 'managed', hosting_config: { pages_project: 'another-site' } });
  const plan = await managedMigrationPlan('org', 'site');
  expect(plan).toMatchObject({ state: 'ready', binding: { project: 'existing-site', previous_deployment_id: 'old-deploy' } });
  expect((await getStore().getDoc<any>(paths.site('org', 'site'))).publishing_mode).toBe('managed');
  expect(requestMediaMigration).not.toHaveBeenCalled();
  await migrateManagedSite('org', 'site', { revision: plan.state === 'ready' ? plan.revision : '' });
  expect(await getStore().getDoc(paths.site('org', 'site'))).toMatchObject({ publishing_mode: 'customer_git', hosting_assignment_locked: true, domain: 'www.example.com', publishing_migration: { project: 'existing-site', previous_deployment_id: 'old-deploy', account_id: account } });
  expect((await getStore().getDoc<any>(paths.site('org', 'other'))).publishing_mode).toBe('managed');
  expect(provider.mock.calls.every(call => call[1]?.method === undefined)).toBe(true);
  expect(requestMediaMigration).toHaveBeenCalledWith('org');
});
it('rejects a different account before querying provider projects', async () => {
  vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', 'b'.repeat(32));
  await expect(managedMigrationPlan('org', 'site')).rejects.toMatchObject({ code: 'managed_account_mismatch' });
  expect(provider).not.toHaveBeenCalled();
});
it.each([
  null,
  { ...project, name: 'another-site' },
  { ...project, production_branch: 'production' },
  { ...project, source: { type: 'github' } },
  { ...project, canonical_deployment: { id: 'old-deploy', uses_functions: true } },
])('rejects an unavailable, changed or dynamic project without creating or modifying it', async value => {
  provider.mockResolvedValue(value);
  await expect(managedMigrationPlan('org', 'site')).rejects.toMatchObject({ code: 'managed_project_mismatch' });
  expect(provider.mock.calls.every(call => call[1]?.method === undefined)).toBe(true);
});
it('rejects a missing host and an unqualified shared engine', async () => {
  provider.mockResolvedValue({ ...project, domains: ['unrelated.example.com'] });
  await expect(managedMigrationPlan('org', 'site')).rejects.toMatchObject({ code: 'managed_domain_mismatch' });
  vi.mocked(readEngineConfiguration).mockResolvedValue({ status: 'verifying' } as any);
  await expect(managedMigrationPlan('org', 'site')).rejects.toMatchObject({ code: 'shared_build_setup_required' });
});
it('rejects stale decisions and active publication jobs', async () => {
  const plan = await managedMigrationPlan('org', 'site');
  await expect(migrateManagedSite('org', 'site', { revision: 'old' })).rejects.toMatchObject({ code: 'managed_migration_changed' });
  await getStore().setDoc(paths.deploy('org', 'site', 'job'), { status: 'running' });
  await expect(migrateManagedSite('org', 'site', { revision: plan.state === 'ready' ? plan.revision : '' })).rejects.toMatchObject({ code: 'publication_in_progress' });
  expect((await getStore().getDoc<any>(paths.site('org', 'site'))).publishing_mode).toBe('managed');
});
it('never recreates a missing adopted project during a subsequent publication', async () => {
  provider.mockResolvedValue(null);
  await expect(verifyManagedProject(provider, { account_id: account, project: 'existing-site', website_host: 'www.example.com', previous_deployment_id: 'old-deploy', hosting_group_id: 'default', migrated_at: '' })).rejects.toMatchObject({ code: 'managed_project_mismatch' });
  expect(provider).toHaveBeenCalledExactlyOnceWith(`/accounts/${account}/pages/projects/existing-site`, { missing: true });
});

it('does not recreate an adopted project that disappears between provider checks', async () => {
  provider.mockResolvedValue(null);
  await expect(prepareStaticProject(provider, `/accounts/${account}/pages/projects/existing-site`, { project: 'existing-site', owner: 'org', repo: 'repo', repository: {}, requireExisting: true })).rejects.toMatchObject({ code: 'managed_project_missing' });
  expect(provider).toHaveBeenCalledTimes(1);
});
