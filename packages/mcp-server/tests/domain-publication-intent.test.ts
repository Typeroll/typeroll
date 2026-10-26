import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { deployTools } from '../src/tools/deploy';
it('accepts and forwards an explicit domain revision without inventing confirmation', async () => {
  const tool=deployTools.find(tool=>tool.name==='trigger_deploy')!;
  const schema=z.object(tool.inputSchema!);
  const args=schema.parse({domain_candidate_revision:'r7',version:'main'});
  const post=vi.fn().mockResolvedValue({job_id:'job'});
  await tool.handler(args,{client:{post},siteId:'site'} as never);
  expect(post).toHaveBeenCalledWith('site','deploy',{domain_candidate_revision:'r7'},{version:'main'});
  expect(schema.parse({})).not.toHaveProperty('domain_candidate_revision');
});
