import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { deployTools } from '../src/tools/deploy';
import { domainTools } from '../src/tools/domain';

it('keeps normal publication separate from explicit domain preparation', async () => {
  const tool = deployTools.find(tool => tool.name === 'trigger_deploy')!;
  const schema = z.object(tool.inputSchema!);
  expect(schema.shape).not.toHaveProperty('domain_candidate_revision');
  const post = vi.fn().mockResolvedValue({ job_id: 'job' });
  await tool.handler(schema.parse({ version: 'main' }), { client: { post }, siteId: 'site' } as never);
  expect(post).toHaveBeenCalledWith('site', 'deploy', {}, { version: 'main' });
  const prepare = domainTools.find(tool => tool.name === 'prepare_publishing_domain_change')!;
  await prepare.handler({ revision: 'reviewed-revision' }, { client: { post }, siteId: 'site' } as never);
  expect(post).toHaveBeenLastCalledWith('site', 'publishing/prepare', { revision: 'reviewed-revision' });
});
