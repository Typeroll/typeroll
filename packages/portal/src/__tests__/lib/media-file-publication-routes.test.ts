import { beforeEach, it, expect, vi } from 'vitest';
import { POST as apiPost } from '../../pages/api/v1/sites/[siteId]/media/[mediaId]/publish';
import { POST as cookiePost } from '../../pages/api/sites/[siteId]/media/[mediaId]/publish';
import { requireApiKey } from '../../lib/api-auth';
import { requireSiteAccess, requirePermission } from '../../lib/access';
import { publishMediaFile } from '../../lib/media/file-publication';
vi.mock('../../lib/api-auth',()=>({ requireApiKey:vi.fn(),apiError:(error:string,status=400)=>Response.json({error},{status}),apiResponse:(_:unknown,data:unknown)=>Response.json(data) }));
vi.mock('../../lib/access',()=>({requireSiteAccess:vi.fn(),requirePermission:vi.fn(),json:(data:unknown,status=200)=>Response.json(data,{status})}));
vi.mock('../../lib/media/file-publication',()=>({publishMediaFile:vi.fn()}));
beforeEach(()=>{vi.resetAllMocks();vi.mocked(publishMediaFile).mockResolvedValue({media_id:'pdf',state:'public',public_url:'https://media.example/pdf',verified_at:'today',website_build_required:false});});
const context=(origin='https://portal.example')=>({params:{siteId:'site',mediaId:'pdf'},request:new Request('https://portal.example/api/sites/site/media/pdf/publish',{method:'POST',headers:{Origin:origin}}),cookies:{},locals:{}} as any);
it('refuses unauthenticated and read-only API callers',async()=>{
  vi.mocked(requireApiKey).mockResolvedValue({ok:false,response:new Response(null,{status:401})});
  expect((await apiPost(context())).status).toBe(401);
  vi.mocked(requireApiKey).mockResolvedValue({ok:true,value:{permission:'read'}} as any);
  expect((await apiPost(context())).status).toBe(403);expect(publishMediaFile).not.toHaveBeenCalled();
});
it('API publication uses the authorized owner organization and site',async()=>{
  vi.mocked(requireApiKey).mockResolvedValue({ok:true,value:{permission:'write',orgId:'owner',siteId:'resolved-site'}} as any);
  expect((await apiPost(context())).status).toBe(200);
  expect(publishMediaFile).toHaveBeenCalledWith('owner','resolved-site','pdf');
});
it('cookie publication requires write permission and the correct Origin',async()=>{
  vi.mocked(requireSiteAccess).mockResolvedValue({ok:true,value:{owner_org_id:'owner',site:{id:'resolved-site'}}} as any);
  vi.mocked(requirePermission).mockReturnValue({ok:false,response:new Response(null,{status:403})});
  expect((await cookiePost(context())).status).toBe(403);
  vi.mocked(requirePermission).mockReturnValue({ok:true} as any);
  expect((await cookiePost(context('https://attacker.example'))).status).toBe(403);
  expect(publishMediaFile).not.toHaveBeenCalled();
  expect((await cookiePost(context())).status).toBe(200);
  expect(publishMediaFile).toHaveBeenCalledWith('owner','resolved-site','pdf');
});
