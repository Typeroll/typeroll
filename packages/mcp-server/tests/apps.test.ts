import { describe, expect, it, vi } from 'vitest';
import { appTools } from '../src/tools/apps.js';

describe('generic app MCP tools', () => {
  it('lists, reads, and writes through the generic bearer API', async () => {
    const get = vi.fn().mockResolvedValue({ apps: [] });
    const put = vi.fn().mockResolvedValue({ ok: true });
    const client = { get, put } as never;
    const list = appTools.find((tool) => tool.name === 'list_apps')!;
    const read = appTools.find((tool) => tool.name === 'read_app')!;
    const update = appTools.find((tool) => tool.name === 'update_app')!;

    await list.handler({}, { client, siteId: 'site-a' });
    expect(get).toHaveBeenCalledWith('site-a', 'apps');

    await read.handler({ app_id: 'analytics' }, { client, siteId: 'site-a' });
    expect(get).toHaveBeenCalledWith('site-a', 'apps/analytics');

    await update.handler({
      app_id: 'analytics',
      enabled: true,
      config: { beacon_token: 'public-beacon' },
    }, { client, siteId: 'site-a' });
    expect(put).toHaveBeenCalledWith('site-a', 'apps/analytics', {
      enabled: true,
      config: { beacon_token: 'public-beacon' },
    });
  });

  it('URL-encodes registry ids at the transport boundary', async () => {
    const get = vi.fn().mockResolvedValue({});
    const client = { get } as never;
    const read = appTools.find((tool) => tool.name === 'read_app')!;
    await read.handler({ app_id: '../analytics' }, { client, siteId: 'site-a' });
    expect(get).toHaveBeenCalledWith('site-a', 'apps/..%2Fanalytics');
  });
});
