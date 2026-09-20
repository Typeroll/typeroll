import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { pageTemplateTools } from '../src/tools/page-templates.js';
const tool = pageTemplateTools.find(item => item.name === 'get_composition_starter')!;
it('reads a single version-bound starter without using a write endpoint', async () => {
  const get = vi.fn().mockResolvedValue({ kind: 'archive', saved: false, blocks: [] });
  const args = z.object(tool.inputSchema!).parse({ kind: 'archive', content_type: 'articles', title: 'Guides', version: 'design' });
  await tool.handler(args, { client: { get }, siteId: 'example' } as never);
  expect(get).toHaveBeenCalledWith('example', 'composition-starters', args);
});
it('rejects unsupported starter kinds and exposes profile/landing in creation', () => {
  expect(z.object(tool.inputSchema!).safeParse({ kind: 'invented' }).success).toBe(false);
  const create = pageTemplateTools.find(item => item.name === 'create_page_template')!;
  for (const starter of ['profile', 'landing']) expect(z.object(create.inputSchema!).safeParse({ name: 'layout', starter }).success).toBe(true);
});
