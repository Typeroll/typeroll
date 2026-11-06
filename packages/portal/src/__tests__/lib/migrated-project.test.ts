import { beforeEach, expect, it, vi } from 'vitest';
import { verifyManagedProject } from '../../lib/publishing/migrated-project';
import { prepareStaticProject } from '../../lib/builds/publication';

const account = 'a'.repeat(32);
const project = { name: 'existing-site', production_branch: 'main', domains: ['www.example.com'], source: null, canonical_deployment: { id: 'old-deploy', uses_functions: false } };
const binding = { account_id: account, project: 'existing-site', website_host: 'www.example.com', previous_deployment_id: 'old-deploy', hosting_group_id: 'default', migrated_at: '' };
const provider = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  provider.mockResolvedValue(structuredClone(project));
});

it('accepts the recorded static project with its website host, reading only', async () => {
  await expect(verifyManagedProject(provider, binding)).resolves.toMatchObject({ name: 'existing-site' });
  expect(provider).toHaveBeenCalledExactlyOnceWith(`/accounts/${account}/pages/projects/existing-site`, { missing: true });
});

it.each([
  null,
  { ...project, name: 'another-site' },
  { ...project, production_branch: 'production' },
  { ...project, source: { type: 'github' } },
  { ...project, canonical_deployment: { id: 'old-deploy', uses_functions: true } },
])('rejects an unavailable, changed or dynamic project without creating or modifying it', async value => {
  provider.mockResolvedValue(value);
  await expect(verifyManagedProject(provider, binding)).rejects.toMatchObject({ code: 'managed_project_mismatch' });
  expect(provider.mock.calls.every(call => call[1]?.method === undefined)).toBe(true);
});

it('rejects a project that no longer serves the website host', async () => {
  provider.mockResolvedValue({ ...project, domains: ['unrelated.example.com'] });
  await expect(verifyManagedProject(provider, binding)).rejects.toMatchObject({ code: 'managed_domain_mismatch' });
});

it('does not recreate an adopted project that disappears between provider checks', async () => {
  provider.mockResolvedValue(null);
  await expect(prepareStaticProject(provider, `/accounts/${account}/pages/projects/existing-site`, { project: 'existing-site', owner: 'org', repo: 'repo', repository: {}, requireExisting: true })).rejects.toMatchObject({ code: 'managed_project_missing' });
  expect(provider).toHaveBeenCalledTimes(1);
});
