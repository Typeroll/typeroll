import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { paths } from '@typeroll/shared';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { getStore } from '../../lib/datastore';
import { buildTasksPath } from '../../lib/builds/queue';
import { wakeCompletedPublication } from '../../lib/builds/publication-wakeup';
import { workPath } from '../../lib/scheduling/index';
const deliver = vi.hoisted(() => vi.fn());
vi.mock('../../lib/scheduling/transport', () => ({ dispatchScheduledWork: deliver }));
const org = 'org', key = 'a'.repeat(64);
const jobPath = paths.deploy(org, 'site', 'job');
const taskPath = `${buildTasksPath(org)}/${key}`;
const eventPath = workPath(jobPath, 'publication');
beforeEach(async () => {
  makeTmpFixtures(); await resetDatastore(); deliver.mockReset();
  await getStore().setDoc(taskPath, { status: 'completed', identity: { org_id: org, site_id: 'site', job_id: 'job', version_id: 'main', publication_id: 'frozen', commit: 'commit' } });
  await getStore().setDoc(jobPath, { status: 'running', version_id: 'main', environment: 'production', git_publication: { publication_id: 'frozen', commit: 'commit', build_task_key: key, verification_task_key: key } });
});
afterEach(() => vi.unstubAllEnvs());
it.each(['publication', 'static_verification'] as const)('persists exactly one next-step event for duplicate %s results', async kind => {
  await wakeCompletedPublication(org, key, kind);
  const first = await getStore().getDoc<any>(eventPath);
  await wakeCompletedPublication(org, key, kind);
  expect(await getStore().getDoc(eventPath)).toEqual(first);
  expect(first).toMatchObject({ kind: 'publication', source: jobPath, payload: { token: `result:${key}` } });
  expect(first.due_at).toBeLessThanOrEqual(Date.now());
});
it.each([{status:'failed'}, {status:'succeeded'}, {version_id:'other'}, {dry_run:true}, {git_publication:{publication_id:'newer',commit:'commit',build_task_key:key}}, {git_publication:{publication_id:'frozen',commit:'other',build_task_key:key}}, {git_publication:{publication_id:'frozen',commit:'commit',build_task_key:'other'}}])('does not resume a superseded or terminal publication: %j', async patch => {
  await getStore().updateDoc(jobPath, patch);
  const before = await getStore().getDoc(eventPath);
  await wakeCompletedPublication(org, key, 'publication');
  expect(await getStore().getDoc(eventPath)).toEqual(before);
});
it('does not schedule another attempt for a running build', async () => {
  await getStore().updateDoc(taskPath, {status:'running'});
  await wakeCompletedPublication(org, key, 'publication');
  expect(await getStore().getDoc(eventPath)).toBeNull();
});
it.each(['failed', 'cancelled'])('immediately wakes the coordinator to report a %s build', async status => {
  await getStore().updateDoc(taskPath, {status});
  await wakeCompletedPublication(org, key, 'publication');
  expect(await getStore().getDoc(eventPath)).toMatchObject({ payload: { token: `result:${key}` } });
});
it('does not wake a publication for background preparation or qualification', async () => {
  await wakeCompletedPublication(org,key,'media_preparation'); await wakeCompletedPublication(org,key,'qualification');
  expect(await getStore().getDoc(eventPath)).toBeNull();
});
it('retains the next event after a queue outage without requiring a second callback', async () => {
  vi.stubEnv('DEPLOY_QUEUE', 'cloud_tasks');
  deliver.mockRejectedValue(Error('synthetic queue outage'));
  await wakeCompletedPublication(org,key,'publication');
  expect(await getStore().getDoc(taskPath)).toMatchObject({status:'completed'});
  expect(await getStore().getDoc(eventPath)).toMatchObject({payload:{token:`result:${key}`}});
  expect(deliver).toHaveBeenCalledOnce();
});
