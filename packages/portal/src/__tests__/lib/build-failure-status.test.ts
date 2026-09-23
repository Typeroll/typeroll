import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { paths } from '@typeroll/shared';
import { getStore } from '../../lib/datastore';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { refreshBuildFailure, buildFailureMessage } from '../../lib/builds/failure-status';
const jobPath = paths.deploy('org','site','job'), taskPath = 'organizations/org/build_tasks/task';
beforeEach(async () => {
  makeTmpFixtures(); await resetDatastore();
  await getStore().setDoc(jobPath, {status:'running',phase:'building',git_publication:{build_task_key:'task'}});
  await getStore().setDoc(taskPath, {status:'running',lease_until:Date.now()-1,lease_id:'attempt',token_hash:'private',identity:{org_id:'org',site_id:'site',job_id:'job'}});
});
afterEach(() => vi.restoreAllMocks());
it('reports loss of an execution on status read without queueing another build', async () => {
  const result = await refreshBuildFailure('org','site',(await getStore().getDoc<any>(jobPath))!);
  expect(result).toMatchObject({status:'failed',failure:{code:'build_connection_lost'}});
  expect(result.error).toContain('No replacement build was started');
  expect(await getStore().getDoc(taskPath)).toMatchObject({status:'failed',token_hash:null});
});
it('does not fail a healthy long-running build', async () => {
  await getStore().updateDoc(taskPath,{lease_until:Date.now()+60000,created_at:1});
  expect(await refreshBuildFailure('org','site',(await getStore().getDoc<any>(jobPath))!)).toMatchObject({status:'running'});
});
it('does not overwrite a completion that wins the status-read race', async () => {
  const store = getStore(), original = store.compareAndUpdateDoc.bind(store);
  vi.spyOn(store,'compareAndUpdateDoc').mockImplementation(async (path,check,patch) => {
    if(path===taskPath) await store.updateDoc(taskPath,{status:'completed'});
    return original(path,check,patch);
  });
  expect(await refreshBuildFailure('org','site',(await store.getDoc<any>(jobPath))!)).toMatchObject({status:'running'});
  expect(await store.getDoc(taskPath)).toMatchObject({status:'completed'});
});
it('does not mistake an explicitly queued continuation for a failed initial dispatch', async () => {
  await getStore().updateDoc(taskPath,{status:'queued',attempt:2,lease_until:0});
  expect(await refreshBuildFailure('org','site',(await getStore().getDoc<any>(jobPath))!)).toMatchObject({status:'running'});
});

it('tells an operator to retry an outage and never to retry a substitution', () => {
  const outage = buildFailureMessage('sandbox_unavailable');
  const substitution = buildFailureMessage('sandbox_integrity_failed');
  expect(outage).not.toBe(substitution);
  expect(outage).toMatch(/retry publishing when a host recovers/);
  // The one case where "check the log, then retry" is active misdirection: a
  // retry is how a substituted artifact gets accepted on the attempt where a
  // source that agrees happens to answer.
  expect(substitution).toMatch(/must not be retried/);
  expect(substitution).not.toMatch(/retry publishing/);
  expect(buildFailureMessage('build_connection_lost')).toMatch(/No replacement build was started/);
  expect(buildFailureMessage('shared_build_failed')).toMatch(/failed or cancelled attempt/);
});
