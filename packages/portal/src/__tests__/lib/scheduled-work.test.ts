import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { paths } from '@typeroll/shared';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { getStore } from '../../lib/datastore';
import { scheduledIndexWrites, workPath } from '../../lib/scheduling/index';
import { executeScheduledWork, runDueScheduledWork, wakePendingSite } from '../../lib/scheduling/worker';
import { waitForBuild, schedulePublication } from '../../lib/scheduling/continuation';
import { wakeCompletedPublication } from '../../lib/builds/publication-wakeup';
import { markSiteDirty } from '../../lib/auto-deploy';
const mocks = vi.hoisted(() => ({ execute: vi.fn(), enqueue: vi.fn() }));
vi.mock('../../lib/deploy/queue', () => ({ executeDeployJob: mocks.execute, getDeployQueue: () => ({ enqueue: mocks.enqueue }) }));
const sitePath = paths.site('org', 'site'), jobPath = paths.deploy('org', 'site', 'job');
const key = 'a'.repeat(64), taskPath = `organizations/org/build_tasks/${key}`;
const now = Date.now();
const id = (path: string) => path.split('/').pop()!;
beforeEach(async () => {
  makeTmpFixtures(); await resetDatastore(); vi.clearAllMocks();
  mocks.execute.mockResolvedValue('ran'); mocks.enqueue.mockResolvedValue(undefined);
  await getStore().setDoc(sitePath, { name: 'Test' });
  await getStore().setDoc(jobPath, { status: 'running', execution_backend: 'organization_cloudflare', version_id: 'main', environment: 'production', started_at: new Date(now).toISOString(), git_publication: { publication_id: 'frozen', commit: 'commit', build_task_key: key } });
  await getStore().setDoc(taskPath, { status: 'running', created_at: now, deadline: now + 100, lease_until: now + 10, attempt: 1, identity: { org_id: 'org', site_id: 'site', job_id: 'job', version_id: 'main', publication_id: 'frozen', commit: 'commit' } });
});
afterEach(() => vi.restoreAllMocks());
it('does not schedule or restart a running build even after its old estimated deadline', async () => {
  await waitForBuild(jobPath, 'org', key);
  await runDueScheduledWork(new Date(now + 86400000));
  expect(mocks.execute).not.toHaveBeenCalled();
  expect(mocks.enqueue).not.toHaveBeenCalled();
  expect(await getStore().listDocs('scheduled_work')).toHaveLength(0);
});
it('chains a completed result once and consumes duplicate deliveries', async () => {
  const store = getStore();
  await store.updateDoc(taskPath, { status: 'completed', completed_at: now });
  await store.setDoc(`organizations/org/build_inputs/${key}`, { kind: 'publication' });
  const buildEventPath = workPath(taskPath, 'build_result');
  await executeScheduledWork(id(buildEventPath));
  const eventPath = workPath(jobPath, 'publication');
  const event = await store.getDoc<any>(eventPath);
  expect(event.due_at).toBeLessThanOrEqual(Date.now());
  await executeScheduledWork(id(eventPath), event.generation);
  await executeScheduledWork(id(eventPath), event.generation);
  expect(mocks.execute).toHaveBeenCalledOnce();
  expect(mocks.execute.mock.calls[0][0]).toMatchObject({ jobId: 'job', versionId: 'main', environment: 'production' });
});
it('does not overwrite a result that arrives while the coordinator saves its waiting state', async () => {
  const store = getStore(), original = store.compareAndReplaceDoc.bind(store);
  let race = true;
  vi.spyOn(store, 'compareAndReplaceDoc').mockImplementation(async (path, expected, value, effects) => {
    if (path === jobPath && race) {
      race = false;
      await store.updateDoc(taskPath, { status: 'completed', completed_at: now });
      await wakeCompletedPublication('org', key, 'publication');
    }
    return original(path, expected, value, effects);
  });
  await waitForBuild(jobPath, 'org', key);
  const event = await store.getDoc<any>(workPath(jobPath, 'publication'));
  expect(event).not.toBeNull();
  expect(event.due_at).toBeLessThanOrEqual(Date.now());
});
it('preserves a newer checkpoint when the previous delivery finishes', async () => {
  await schedulePublication(jobPath, 'first');
  const eventPath = workPath(jobPath, 'publication');
  const first = await getStore().getDoc<any>(eventPath);
  mocks.execute.mockImplementationOnce(async () => { await schedulePublication(jobPath, 'second'); return 'continue'; });
  await executeScheduledWork(id(eventPath), first.generation);
  const next = await getStore().getDoc<any>(eventPath);
  expect(next.generation).not.toBe(first.generation);
  expect(next.due_at).toBeLessThanOrEqual(Date.now());
  await executeScheduledWork(id(eventPath), first.generation);
  expect(mocks.execute).toHaveBeenCalledOnce();
});
it('retries the same failed delivery without inventing a new publication', async () => {
  await schedulePublication(jobPath, 'first');
  const eventPath = workPath(jobPath, 'publication');
  const first = await getStore().getDoc<any>(eventPath);
  mocks.execute.mockRejectedValueOnce(new Error('temporary outage'));
  await expect(executeScheduledWork(id(eventPath), first.generation)).rejects.toThrow('temporary outage');
  expect(await getStore().getDoc(eventPath)).toMatchObject({ generation: first.generation, lease_until: 0 });
  await executeScheduledWork(id(eventPath), first.generation);
  expect(mocks.execute.mock.calls.map(call => call[0].jobId)).toEqual(['job', 'job']);
});
it('does not scan customer content when checking undelivered events', async () => {
  const spy = vi.spyOn(getStore(), 'listDocs');
  await runDueScheduledWork();
  expect(spy.mock.calls.map(call => call[0])).toEqual(['scheduled_work']);
});
it('does not execute a cancelled or rescheduled page schedule', async () => {
  const page = `${paths.pages('org','site')}/page`;
  await getStore().setDoc(page, { status:'draft', publish_at:new Date(now-1000).toISOString() });
  const eventPath = workPath(page, 'page_schedule'), old = await getStore().getDoc<any>(eventPath);
  await getStore().updateDoc(page, { publish_at:new Date(now+86400000).toISOString() });
  await executeScheduledWork(id(eventPath), old.generation);
  expect(await getStore().getDoc(page)).toMatchObject({status:'draft'});
  await getStore().updateDoc(page, { publish_at:null });
  expect(await getStore().getDoc(eventPath)).toBeNull();
});
it('does not use version pages as production schedules', () => {
  expect(scheduledIndexWrites('organizations/org/sites/site/versions/preview/pages/page', null, {status:'draft',publish_at:new Date(now).toISOString()})).toEqual([]);
});
it('retains an edit arriving during dispatch even if its dirty timestamp is unchanged', async () => {
  const store = getStore();
  await store.updateDoc(jobPath, {status:'succeeded'});
  await store.updateDoc(sitePath, {auto_deploy:{enabled:true,debounce_minutes:0},pending_deploy_at:new Date(now-1000).toISOString(),pending_deploy_revision:'first'});
  const eventPath = workPath(sitePath,'site_publish');
  const first = await store.getDoc<any>(eventPath);
  mocks.enqueue.mockImplementationOnce(async () => markSiteDirty('org','site'));
  await executeScheduledWork(id(eventPath), first.generation);
  expect(await store.getDoc(sitePath)).toMatchObject({pending_deploy_at:new Date(now-1000).toISOString()});
  expect((await store.getDoc<any>(eventPath)).generation).not.toBe(first.generation);
});
it('job completion never shortens a future auto-publish delay', async () => {
  await getStore().updateDoc(sitePath, {auto_deploy:{enabled:true,debounce_minutes:15},pending_deploy_at:new Date(now).toISOString()});
  const eventPath = workPath(sitePath,'site_publish'), before = await getStore().getDoc(eventPath);
  await wakePendingSite('org','site','job');
  expect(await getStore().getDoc(eventPath)).toEqual(before);
});
it('parks a due site behind the active job and wakes only on its completion', async () => {
  await getStore().updateDoc(sitePath, {auto_deploy:{enabled:true,debounce_minutes:0},pending_deploy_at:new Date(now-1000).toISOString()});
  const path = workPath(sitePath,'site_publish');
  await executeScheduledWork(id(path));
  expect(await getStore().getDoc(path)).toMatchObject({blocked_by:'job',due_at:Number.MAX_SAFE_INTEGER});
  expect(mocks.enqueue).not.toHaveBeenCalled();
  await wakePendingSite('org','site','other');
  expect((await getStore().getDoc<any>(path)).due_at).toBe(Number.MAX_SAFE_INTEGER);
  await wakePendingSite('org','site','job');
  expect((await getStore().getDoc<any>(path)).due_at).toBeLessThanOrEqual(Date.now());
});
