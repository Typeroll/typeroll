import { beforeEach, expect, it, vi } from 'vitest';
import { paths } from '@typeroll/shared';
import { getStore } from '../../lib/datastore';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
vi.mock('../../lib/api-auth', () => ({
  requireApiKey: async () => ({ok:true,value:{orgId:'org',siteId:'site',site:{id:'site'}}}),
  apiResponse: (_ctx: unknown, data: unknown) => Response.json(data), apiError: (message:string,status=400)=>Response.json({message},{status}),
}));
vi.mock('../../lib/deploy/availability', () => ({refreshDeploymentAvailability:async(_org: string,_site: string,job: unknown)=>job}));
import { GET } from '../../pages/api/v1/sites/[siteId]/deploys/[jobId]';
beforeEach(async()=>{makeTmpFixtures();await resetDatastore();});
it('keeps an explicit wait behind another publication out of the undispatched-worker timeout',async()=>{
  await getStore().setDoc(paths.deploy('org','site','job'),{status:'queued',started_at:new Date(Date.now()-600000).toISOString(),waiting_for_job_id:'previous'});
  const response = await GET({request:new Request('http://localhost/api'),params:{siteId:'site',jobId:'job'}} as any);
  expect(await response.json()).toMatchObject({job:{status:'queued'},waiting_for_job_id:'previous',supersedes_previous:false,queue_timeout_seconds:null});
});
it('still terminates a genuinely undispatched job after the worker timeout',async()=>{
  await getStore().setDoc(paths.deploy('org','site','job'),{status:'queued',started_at:new Date(Date.now()-600000).toISOString()});
  const response = await GET({request:new Request('http://localhost/api'),params:{siteId:'site',jobId:'job'}} as any);
  expect(await response.json()).toMatchObject({job:{status:'failed',phase:'queue_timeout'},queue_timeout_seconds:300});
});
