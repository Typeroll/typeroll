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

it('names the step, the reason and the cause of every reported failure', () => {
  const diagnostic = { cause: 'Error: Invalid media completion receipt', lines: [] };
  expect(buildFailureMessage('media_build_process_exit_1', diagnostic)).toBe('The build failed while preparing images and files: the step exited with code 1. Cause: Error: Invalid media completion receipt. Resolve the cause, then retry publishing. (media_build_process_exit_1)');
  expect(buildFailureMessage('media_build_process_exit_1')).toMatch(/^The build failed while preparing images and files: the step exited with code 1\. Check the build log/);
  expect(buildFailureMessage('dependencies_build_enospc')).toMatch(/installing the site’s build dependencies: the build machine ran out of disk space/);
  expect(buildFailureMessage('rendering_build_process_timeout')).toMatch(/rendering the static pages: the step did not finish within its time limit/);
  expect(buildFailureMessage('extension_assets_build_err_module_not_found')).toMatch(/preparing Extension assets: a module the build imports could not be found/);
  expect(buildFailureMessage('artifact_static_output_size_limit')).toMatch(/Reduce the published files/);
  expect(buildFailureMessage('source_unsupported_build_runtime')).toMatch(/Update the build engine/);
  expect(buildFailureMessage('media_media_transfer_interrupted')).toMatch(/Prepared images are kept/);
  expect(buildFailureMessage('verification_coordinator_502')).toMatch(/answered HTTP 502/);
  expect(buildFailureMessage('sandbox_integrity_failed', diagnostic)).toMatch(/must not be retried.*Cause: Error: Invalid media completion receipt\.$/);
});

it('reports the cause a build engine sent when a status read finds the failure', async () => {
  const error_detail = { cause: 'Error: Invalid media completion receipt', lines: ['Error: Invalid media completion receipt'] };
  await getStore().updateDoc(taskPath, { status: 'failed', error_code: 'media_build_process_exit_1', error_detail });
  const result = await refreshBuildFailure('org','site',(await getStore().getDoc<any>(jobPath))!);
  expect(result).toMatchObject({ status: 'failed', failure: { code: 'media_build_process_exit_1', diagnostic: error_detail } });
  expect(result.error).toContain('Cause: Error: Invalid media completion receipt.');
});

