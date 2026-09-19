import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { pageTools } from '../src/tools/pages.js';
it('preserves per-entry keyed source metadata through batch tool validation and save shorthand', async () => {
  const tool = pageTools.find(tool => tool.name === 'batch_update_pages')!;
  const source = { 'programs/@stable~1a/online': { source_url:'https://example.org/research',import_run_id:'import-2026' } };
  const parsed = z.object(tool.inputSchema).parse({updates:[{page_id:'profile',patch:{fields:{online:true}},answer_sources:source}],save:true,version:'migration'});
  const post = vi.fn().mockResolvedValue({results:[]});
  await tool.handler(parsed,{client:{post} as never,siteId:'site'});
  expect(post).toHaveBeenCalledWith('site','pages/batch-write',[{...parsed.updates[0],save:true}],{version:'migration'});
  expect(parsed.updates[0].answer_sources).toEqual(source);
  expect(()=>z.object(tool.inputSchema).parse({updates:[{page_id:'profile',patch:{},answer_sources:{online:{source:'owner'}}}]})).toThrow();
});
