import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getStore } from '../../lib/datastore';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { expireQueuedBuild, queuedBuildExpired, BUILD_QUEUE_WAIT_MS, type BuildTask } from '../../lib/builds/queue';
import { refreshBuildFailure } from '../../lib/builds/failure-status';
import { publicationBuildProgress } from '../../lib/builds/public-progress';
import { createProviderClient, githubFailureHint } from '../../lib/publishing/providers.mjs';
import { paths } from '@typeroll/shared';
const key = 'a'.repeat(64), taskPath=`organizations/org/build_tasks/${key}`, jobPath=paths.deploy('org','site','job');
beforeEach(async()=>{makeTmpFixtures();await resetDatastore();});
afterEach(()=>vi.restoreAllMocks());
it('expires an unclaimed media step on status read and exposes the real waiting state',async()=>{
  const task={status:'queued',attempt:0,queued_at:Date.now()-BUILD_QUEUE_WAIT_MS-1,deadline:Date.now()+3600000,media_total:249,media_cursor:0,identity:{org_id:'org',site_id:'site',job_id:'job',version_id:'main'}};
  await getStore().setDoc(taskPath,task);
  await getStore().setDoc(jobPath,{status:'running',version_id:'main',git_publication:{build_task_key:key}});
  const job=(await getStore().getDoc<any>(jobPath))!;
  expect(await publicationBuildProgress('org','site',job)).toMatchObject({step:'waiting_for_runner',completed:0,total:249});
  expect(await refreshBuildFailure('org','site',job)).toMatchObject({status:'failed',failure:{code:'build_queue_timeout'}});
  expect(await getStore().getDoc(taskPath)).toMatchObject({status:'failed',token_hash:null});
});
it('does not revoke a claim that wins the expiration race',async()=>{
  await getStore().setDoc(taskPath,{status:'queued',queued_at:1,deadline:Date.now()+3600000});
  const store=getStore(), original=store.compareAndUpdateDoc.bind(store);
  vi.spyOn(store,'compareAndUpdateDoc').mockImplementation(async(path,check,patch)=>{
    await store.updateDoc(path,{status:'running',lease_until:Date.now()+90000});return original(path,check,patch);
  });
  await expireQueuedBuild(store,'org',key);
  expect(await store.getDoc(taskPath)).toMatchObject({status:'running'});
});
it('measures a continuation from its checkpoint, not the age of the entire media job',()=>{
  expect(queuedBuildExpired({status:'queued',created_at:1,queued_at:Date.now(),deadline:Date.now()+3600000} as BuildTask)).toBe(false);
  expect(queuedBuildExpired({status:'running',created_at:1,deadline:1} as BuildTask)).toBe(false);
});
it('classifies a GitHub 422 without leaking its reflected body',async()=>{
  const client=createProviderClient('GitHub','fake',async()=>new Response(JSON.stringify({message:'Update is not a fast forward',secret:'sensitive-value'}),{status:422}));
  try { await client('/repos/org/repo/git/refs/heads/main',{method:'PATCH',body:{sha:'test'}}); throw new Error('expected failure'); }
  catch(error:any) { expect(error.reason).toBe('non_fast_forward');expect(githubFailureHint(error)).toContain('branch changed');expect(JSON.stringify(error)).not.toContain('sensitive-value'); }
});
