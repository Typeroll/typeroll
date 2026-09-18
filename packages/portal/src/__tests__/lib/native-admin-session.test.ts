import {beforeEach,describe,expect,it,vi} from 'vitest';
const mock=vi.hoisted(()=>({guard:vi.fn(),permission:vi.fn(),getDoc:vi.fn(),resolve:vi.fn(),approved:vi.fn(),sign:vi.fn()}));
vi.mock('../../lib/access',()=>({requireSiteAccess:mock.guard,requirePermission:mock.permission,json:(body:unknown,status=200)=>Response.json(body,{status})}));
vi.mock('../../lib/datastore',()=>({getStore:()=>({getDoc:mock.getDoc})}));
vi.mock('../../lib/extensions/resolution',()=>({resolveExtensionVersion:mock.resolve}));
vi.mock('../../lib/extensions/native-admin',()=>({approvedNativeAdmin:mock.approved}));
vi.mock('../../lib/extensions/auth',()=>({signDelegatedExtensionToken:mock.sign,extensionIssuer:()=> 'https://portal.example.test'}));
import {POST} from '../../pages/api/sites/[siteId]/extensions/[installationId]/admin-session';
const call=()=>POST({cookies:{},locals:{},params:{siteId:'site',installationId:'install'},request:new Request('https://portal.example.test/session',{method:'POST',body:JSON.stringify({page_id:'settings'})})} as never);
describe('native admin session authorization',()=>{
 beforeEach(()=>{
  vi.resetAllMocks();mock.guard.mockResolvedValue({ok:true,value:{owner_org_id:'owner',site:{id:'site'},session:{userId:'user'},permission:'admin'}});
  mock.permission.mockReturnValue({ok:true});mock.getDoc.mockResolvedValue({id:'install',status:'enabled',extension_id:'app',granted_scopes:['content:read']});
  mock.resolve.mockResolvedValue({version:{version:'1.1.0',manifest:{admin:{pages:[{id:'settings',minimum_permission:'admin',native:{sdk_version:1}}]}}}});
  mock.approved.mockResolvedValue(true);mock.sign.mockReturnValue({token:'synthetic',claims:{exp:123}});
 });
 it('binds the delegated token to the authenticated user and owner organization',async()=>{
  const response=await call();expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(mock.sign).toHaveBeenCalledWith(expect.objectContaining({sub:'user',org_id:'owner',site_id:'site',installation_id:'install',aud:'app',token_use:'portal_admin',page_id:'settings',version:'1.1.0'}));
 });
 it('never signs a token for a denied session, disabled app, unapproved release or insufficient role',async()=>{
  mock.guard.mockResolvedValueOnce({ok:false,response:new Response(null,{status:401})});expect((await call()).status).toBe(401);
  mock.getDoc.mockResolvedValueOnce({status:'disabled'});expect((await call()).status).toBe(404);
  mock.approved.mockResolvedValueOnce(false);expect((await call()).status).toBe(403);
  mock.permission.mockReturnValueOnce({ok:false,response:new Response(null,{status:403})});expect((await call()).status).toBe(403);
  expect(mock.sign).not.toHaveBeenCalled();
 });
});
