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
it('exposes responsive scale and fluid controls to hosted and stdio clients',()=>{
 const schema=z.object(settingsTools.find(t=>t.name==='update_site_settings')!.inputSchema!);
 expect(schema.safeParse({typography:{ratio_mobile:1.2,rhythm:1.1},design_scales:{type_size:{'3xl':{mobile:'2rem',desktop:'3rem'}}}}).success).toBe(true);
 expect(schema.safeParse({design_scales:{space:{lg:{phone:'1rem'}}}}).success).toBe(false);
});
