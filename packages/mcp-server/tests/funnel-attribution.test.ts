import { describe, expect, it, vi } from 'vitest';
import { funnelAttributionTools } from '../src/tools/funnel-attribution.js';

describe('funnel attribution MCP tools', () => {
  it('reads and writes through the matching bearer API endpoint', async () => {
    const get = vi.fn().mockResolvedValue({ state: { enabled: false } });
    const put = vi.fn().mockResolvedValue({ ok: true });
    const client = { get, put } as never;
    const read = funnelAttributionTools.find((tool) => tool.name === 'read_funnel_attribution')!;
    const update = funnelAttributionTools.find((tool) => tool.name === 'update_funnel_attribution')!;

    await read.handler({}, { client, siteId: 'site-a' });
    expect(get).toHaveBeenCalledWith('site-a', 'apps/funnel_attribution');

    await update.handler({
      enabled: true,
      funnels: [{
        id: 'campaign', parameters: [{ from: 'utm_source' }],
        targets: [{ type: 'link', host: 'example.com', path: '/book' }],
      }],
      allow_personal_data: false,
      allow_synthetic_fallbacks: false,
    }, { client, siteId: 'site-a' });
    expect(put).toHaveBeenCalledWith('site-a', 'apps/funnel_attribution', expect.objectContaining({
      enabled: true,
      config: expect.objectContaining({
        allow_personal_data: false,
        allow_synthetic_fallbacks: false,
      }),
    }));
  });
});
