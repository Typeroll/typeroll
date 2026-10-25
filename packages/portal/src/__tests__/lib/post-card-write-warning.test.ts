import { it, expect } from 'vitest';
import { buildCoreBlockRegistry } from '@typeroll/shared';
import { singleBlockWriteWarnings } from '../../lib/block-write-warnings';
it('warns about a conflicting saved action when enabling whole-card links', async () => {
  const ctx = {orgId:'test',siteId:'test',versionId:'main'};
  const blocks = [{id:'card',type:'core/post_card',data:{action_label:'Read',whole_card_link:true}}];
  const result = await singleBlockWriteWarnings(ctx,blocks,'card',{data:{whole_card_link:true}},buildCoreBlockRegistry());
  expect(result).toEqual(expect.arrayContaining([expect.objectContaining({code:'ineffective_whole_card_link'})]));
  const cleared = await singleBlockWriteWarnings(ctx,blocks,'card',{data:{whole_card_link:true,action_label:null}},buildCoreBlockRegistry());
  expect(cleared.some(row=>row.code==='ineffective_whole_card_link')).toBe(false);
});
