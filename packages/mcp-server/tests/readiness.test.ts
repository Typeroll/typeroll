import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { readinessTools } from '../src/tools/readiness.js';

it('reads the version-bound launch readiness report', async () => {
  const tool = readinessTools.find(t => t.name === 'read_site_readiness')!;
  const get = vi.fn().mockResolvedValue({ summary: { ok: 1, suggestions: 0, warnings: 0 }, items: [] });
  await tool.handler(z.object(tool.inputSchema!).parse({ version: 'launch' }), { client: { get }, siteId: 'example' } as never);
  expect(get).toHaveBeenCalledWith('example', 'readiness', { version: 'launch' });
  await tool.handler(z.object(tool.inputSchema!).parse({}), { client: { get }, siteId: 'example' } as never);
  expect(get).toHaveBeenLastCalledWith('example', 'readiness', undefined);
  expect(tool.description).toContain('never blockers');
});
