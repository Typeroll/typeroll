import { beforeEach, expect, it, vi } from 'vitest';
import { paths } from '@typeroll/shared';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { getStore } from '../../lib/datastore';
import { approveDomainCutover, getSiteDomains, saveSiteDomains, siteDomainConfigPath } from '../../lib/publishing/domain-config';
const enqueue = vi.hoisted(() => vi.fn());
vi.mock('../../lib/deploy/queue', () => ({ getDeployQueue: () => ({ enqueue }) }));
let revision: string;
beforeEach(async () => {
  makeTmpFixtures(); await resetDatastore(); enqueue.mockReset(); enqueue.mockResolvedValue(undefined);
  revision = (await getSiteDomains('org', 'site')).revision;
  await getStore().updateDoc(siteDomainConfigPath('org', 'site'), {
    candidate: { id: 'frozen', revision, job_id: 'job' },
    preparation: { hostname: 'www.example.com', certificate_ready: true, has_existing_traffic: true, requirements: [], dns_fingerprint: 'dns' },
  });
  await getStore().setDoc(paths.deploy('org', 'site', 'job'), { status: 'running', phase: 'awaiting domain cutover approval',
    started_at: '2020-01-01T00:00:00Z', git_publication: { publication_id: 'frozen', commit: 'unchanged' } });
});

it('resumes the same frozen job after delayed approval with a stable separate dispatch identity', async () => {
  const input = { revision, candidate_id: 'frozen' };
  await approveDomainCutover('org', 'site', input);
  await approveDomainCutover('org', 'site', input);
  const first = enqueue.mock.calls[0][0];
  expect(first).toMatchObject({ orgId: 'org', siteId: 'site', jobId: 'job', versionId: 'main', environment: 'production', dispatchKey: expect.stringMatching(/^[a-f0-9]{16}$/) });
  expect(enqueue.mock.calls[1][0]).toEqual(first);
  const job = await getStore().getDoc<any>(paths.deploy('org', 'site', 'job'));
  expect(Date.parse(job.observation_started_at)).toBeGreaterThan(Date.now() - 5000);
  expect(job.git_publication.commit).toBe('unchanged');
});

it('reports failed queue submission and allows retry without discarding the approved snapshot', async () => {
  enqueue.mockRejectedValueOnce(new Error('Synthetic queue unavailable'));
  await expect(approveDomainCutover('org', 'site', { revision, candidate_id: 'frozen' })).rejects.toMatchObject({ code: 'cutover_enqueue_failed' });
  await approveDomainCutover('org', 'site', { revision, candidate_id: 'frozen' });
  expect((await getSiteDomains('org', 'site')).candidate?.id).toBe('frozen');
});

it('supersedes a parked publication when its desired domains change', async () => {
  await saveSiteDomains('org', 'site', { revision, website_host: 'new.example.com', media_host: 'media.example.com', dns_mode: 'automatic' });
  expect(await getStore().getDoc<any>(paths.deploy('org', 'site', 'job'))).toMatchObject({ status: 'failed', phase: 'superseded' });
  expect(enqueue).not.toHaveBeenCalled();
});
