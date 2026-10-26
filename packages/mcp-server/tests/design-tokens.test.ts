import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { settingsTools } from '../src/tools/settings.js';
it('exposes a version-bound read-only token audit', async () => {
  const tool = settingsTools.find(t => t.name === 'lint_design_tokens')!;
  const args = z.object(tool.inputSchema!).parse({version:'design'});
  const get = vi.fn().mockResolvedValue({blocking:false,findings:[]});
  await tool.handler(args,{client:{get},siteId:'example'} as never);
  expect(get).toHaveBeenCalledWith('example','design-token-audit',{version:'design'});
});
it('accepts named scale settings in the connected MCP schema', () => {
  const tool = settingsTools.find(t => t.name === 'update_site_settings')!;
  expect(z.object(tool.inputSchema!).safeParse({design_scales:{space:{md:'1rem'}}}).success).toBe(true);
});
