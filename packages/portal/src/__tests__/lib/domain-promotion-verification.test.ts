import { beforeEach, expect, it, vi } from 'vitest';
import { getStore } from '../../lib/datastore';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { verifyCustomerCandidate } from '../../lib/builds/publication';
import { wakeCompletedPublication } from '../../lib/builds/publication-wakeup';
const mocks = vi.hoisted(() => ({ enqueue: vi.fn(), completed: vi.fn() }));
vi.mock('../../lib/builds/jobs', () => ({ enqueueBuild: mocks.enqueue, completedBuild: mocks.completed }));
vi.mock('../../lib/builds/state', () => ({ readEngineConfiguration: async () => ({ revision: 'engine', static_verification: true }) }));
vi.mock('../../lib/builds/storage', () => ({ buildStorage: async (_org: string, work: any) => work({ read: async () => Buffer.from('[]') }) }));
const path = 'organizations/org/sites/site/deploys/job';
const identity = { org_id: 'org', site_id: 'site', job_id: 'job', version_id: 'main', publication_id: 'frozen', commit: 'prepared-commit', branch: 'version-domain' };
beforeEach(async () => {
  makeTmpFixtures(); await resetDatastore(); mocks.enqueue.mockReset(); mocks.completed.mockReset();
  await getStore().setDoc('organizations/org/build_tasks/build', { engine_revision: 'engine', identity, status: 'completed' });
  mocks.enqueue.mockImplementation(async (_config, identity) => {
    await getStore().setDoc('organizations/org/build_tasks/verification', { identity, status: 'running' });
    return { key: 'verification' };
  });
  mocks.completed.mockResolvedValue(null);
});
it('resumes the promoted publication from verification of its retained artifact', async () => {
  const publication = { account_id: 'account', project: 'site', website_host: 'www.example.com', domain_revision: 'domains',
    build_task_key: 'build', verification_checks_key: 'checks', publication_id: 'frozen', commit: 'promoted-commit', branch: 'main' };
  await getStore().setDoc(path, { status: 'running', version_id: 'main', git_publication: publication });
  expect(await verifyCustomerCandidate('org', path, publication, 'https://promoted.site.pages.dev')).toBe(false);
  expect(mocks.enqueue.mock.calls[0][1]).toMatchObject({ ...identity, commit: 'promoted-commit', branch: 'main' });
  await getStore().updateDoc('organizations/org/build_tasks/verification', { status: 'completed' });
  await wakeCompletedPublication('org', 'verification', 'static_verification');
  expect(await getStore().getDoc(path)).toMatchObject({ continuation: { reason: 'build_result', token: 'result:verification' } });
  expect(await getStore().getDoc('organizations/org/build_tasks/build')).toMatchObject({ identity });
});
it('rejects verification without a committed publication identity', async () => {
  await expect(verifyCustomerCandidate('org', path, { account_id: 'account', project: 'site', website_host: 'www.example.com', domain_revision: 'domains', build_task_key: 'build', commit: null, branch: 'main' }, 'https://promoted.site.pages.dev')).rejects.toMatchObject({ code: 'publication_commit_required' });
  expect(mocks.enqueue).not.toHaveBeenCalled();
});
