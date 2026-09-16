import { beforeEach, describe, expect, it, vi } from 'vitest';
const state=vi.hoisted(()=>({ctx:{orgId:'org',siteId:'site',versionId:'main',extensionIdentity:{installationId:'app',scopes:['content:owner']}} as any,page:{id:'record',content_type:'business',fields:{description:'Original',tags:['one'],private:'keep'}} as any,type:{id:'business',fields:[{name:'description',type:'richtext',writable_by:['owner','portal']},{name:'tags',type:'multiselect',options:['one','two'],writable_by:['owner','portal']},{name:'private',type:'text',writable_by:['portal']}],page_field_rules:{title:{writable_by:['owner','portal']}}}}));
const write=vi.hoisted(()=>vi.fn());
vi.mock('../../lib/api-auth',()=>({requireApiKey:async()=>({ok:true,value:state.ctx}),apiError:(error:string,status=400)=>Response.json({error},{status}),apiResponse:(_ctx:unknown,body:unknown,status=200)=>Response.json(body,{status})}));
vi.mock('../../lib/version-store',()=>({vstore:{page:async()=>state.page,contentType:async()=>state.type,writePage:write}}));
vi.mock('../../lib/auto-deploy',()=>({markSiteDirty:vi.fn()}));
import { GET,PUT } from '../../pages/api/v1/sites/[siteId]/pages/[pageId]/owner-fields';
const call=(body:unknown)=>PUT({request:new Request('https://cms.example/api/v1/sites/site/pages/record/owner-fields',{method:'PUT',body:JSON.stringify(body)}),params:{siteId:'site',pageId:'record'}} as never);
describe('generic installation owner-authorized editing',()=>{
  beforeEach(()=>{write.mockClear();state.ctx.extensionIdentity={installationId:'app',scopes:['content:owner']};delete state.page._provenance;});
  it('does not expose non-owner fields and accepts no ordinary API key as visitor authority',async()=>{
    const response=await GET({request:new Request('https://cms.example'),params:{pageId:'record'}} as never);
    expect((await response.json()).fields.map((f:any)=>f.name)).toEqual(['description','tags','title']);
    delete state.ctx.extensionIdentity;expect((await call({title:'Changed'})).status).toBe(403);expect(write).not.toHaveBeenCalled();
  });
  it('rejects field escalation and invalid typed metadata before writing',async()=>{
    expect((await call({private:'overwrite'})).status).toBe(403);expect((await call({title:{bad:true}})).status).toBe(400);expect((await call({tags:['unknown']})).status).toBe(400);expect(write).not.toHaveBeenCalled();
  });
  it('preserves portal precedence and reports a conflict',async()=>{state.page._provenance={description:{source:'portal',actor:'editor',updated_at:'2026-01-01'}};expect((await call({description:'Overwrite'})).status).toBe(409);expect(write).not.toHaveBeenCalled();});
  it('sanitizes owner rich text and preserves unrelated data with provenance',async()=>{
    expect((await call({description:'<p>Updated</p><script>alert(1)</script>',tags:['one','two']})).status).toBe(200);
    expect(write).toHaveBeenCalledWith('org','site','main','record',expect.objectContaining({fields:{description:'<p>Updated</p>',tags:['one','two'],private:'keep'},_provenance:expect.objectContaining({description:expect.objectContaining({source:'owner',actor:'extension:app'})})}));
  });
});
