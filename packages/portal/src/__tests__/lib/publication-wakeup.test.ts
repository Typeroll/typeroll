import { beforeEach, expect, it, vi } from 'vitest';
import { paths } from '@typeroll/shared';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { getStore } from '../../lib/datastore';
import { buildTasksPath } from '../../lib/builds/queue';
import { wakeCompletedPublication } from '../../lib/builds/publication-wakeup';
const enqueue = vi.hoisted(() => vi.fn());
vi.mock('../../lib/deploy/queue', () => ({ getDeployQueue: () => ({ enqueue }) }));
const org = 'org', key = 'a'.repeat(64);
const jobPath = paths.deploy(org, 'site', 'job');
const taskPath = `${buildTasksPath(org)}/${key}`;
beforeEach(async () => {
  makeTmpFixtures(); await resetDatastore(); enqueue.mockReset(); enqueue.mockResolvedValue(undefined);
  await getStore().setDoc(taskPath, { status: 'completed', identity: { org_id: org, site_id: 'site', job_id: 'job', version_id: 'main', publication_id: 'frozen', commit: 'commit' } });
  await getStore().setDoc(jobPath, { status: 'running', version_id: 'main', environment: 'production', git_publication: { publication_id: 'frozen', commit: 'commit', build_task_key: key, verification_task_key: key } });
});
it.each(['publication', 'static_verification'] as const)('immediately resumes %s with a stable distinct dispatch identity', async kind => {
  await wakeCompletedPublication(org, key, kind); await wakeCompletedPublication(org, key, kind);
  expect(enqueue).toHaveBeenCalledTimes(2);
  expect(enqueue.mock.calls[0][0]).toEqual({ orgId: org, siteId: 'site', jobId: 'job', versionId: 'main', environment: 'production', delayMs: 0, dispatchKey: expect.stringMatching(/^[a-f0-9]{16}$/) });
  expect(enqueue.mock.calls[1]).toEqual(enqueue.mock.calls[0]);
});
it.each([{status:'failed'}, {status:'succeeded'}, {version_id:'other'}, {dry_run:true}, {git_publication:{publication_id:'newer',commit:'commit',build_task_key:key}}, {git_publication:{publication_id:'frozen',commit:'other',build_task_key:key}}, {git_publication:{publication_id:'frozen',commit:'commit',build_task_key:'other'}}])('does not resume a superseded or terminal publication: %j', async patch => {
  await getStore().updateDoc(jobPath, patch); await wakeCompletedPublication(org, key, 'publication'); expect(enqueue).not.toHaveBeenCalled();
});
it.each(['running', 'failed', 'cancelled'])('ignores a %s build', async status => {
  await getStore().updateDoc(taskPath, {status}); await wakeCompletedPublication(org, key, 'publication'); expect(enqueue).not.toHaveBeenCalled();
});
it('does not wake a publication for background preparation or qualification', async () => {
  await wakeCompletedPublication(org,key,'media_preparation'); await wakeCompletedPublication(org,key,'qualification'); expect(enqueue).not.toHaveBeenCalled();
});
it('keeps the completed result when immediate queue delivery fails so durable observation can recover', async () => {
  enqueue.mockRejectedValueOnce(Error('synthetic queue outage'));
  await expect(wakeCompletedPublication(org,key,'publication')).rejects.toThrow('synthetic queue outage');
  expect(await getStore().getDoc(taskPath)).toMatchObject({status:'completed'});
  await wakeCompletedPublication(org,key,'publication'); expect(enqueue).toHaveBeenCalledTimes(2);
});
