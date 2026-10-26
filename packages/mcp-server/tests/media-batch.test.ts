import { afterEach, expect, it, vi } from 'vitest';
import type { TyperollClient } from '../src/client.js';
import { mediaTools } from '../src/tools/media.js';
afterEach(() => vi.unstubAllGlobals());

it('delegates URL imports to customer storage without downloading bytes in MCP', async () => {
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('MCP must not download imported files'); }));
  const post = vi.fn(async (_site: string, path: string, body: any) => {
    expect(path).toBe('media/import');
    if (body.source_url.includes('broken')) throw new Error('Source unavailable');
    return { media_id: body.source_url, finalize_error: null };
  });
  const tool = mediaTools.find(item => item.name === 'upload_media_batch_from_urls')!;
  const items = ['first', 'broken', 'third'].map(name => ({ source_url: `https://source.example.com/${name}.jpg` }));
  const result = await tool.handler({ items } as never, { client: { post } as unknown as TyperollClient, siteId: 'site' });
  const payload = JSON.parse(result.content[0]!.text);
  expect(payload).toMatchObject({ succeeded: 2, failed: 1 });
  expect(payload.results.map((entry: any) => entry.source_url)).toEqual(items.map(item => item.source_url));
  expect(post).toHaveBeenCalledTimes(3);
  expect(fetch).not.toHaveBeenCalled();
});

it('reports missing organization storage without falling back to an upload URL', async () => {
  vi.stubGlobal('fetch', vi.fn());
  const post = vi.fn().mockRejectedValue(new Error('Connect and verify your organization’s own storage in Publishing → Media storage before starting an import.'));
  const tool = mediaTools.find(item => item.name === 'upload_media_from_url')!;
  const result = await tool.handler({ source_url: 'https://source.example.com/image.jpg' } as never, { client: { post } as unknown as TyperollClient, siteId: 'site' });
  expect(result.isError).toBe(true);
  expect(result.content[0]!.text).toContain('Publishing → Media storage');
  expect(post).toHaveBeenCalledExactlyOnceWith('site', 'media/import', { source_url: 'https://source.example.com/image.jpg' });
  expect(fetch).not.toHaveBeenCalled();
});

it('reports the stored filename when the server appends the type extension to an inline upload', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 200 })));
  const post = vi.fn(async (_site: string, path: string) => path === 'media/upload-url'
    ? { upload_url: 'https://upload.example.com/put', cdn_url: 'https://cdn.example.com/logo.png', key: 'k', media_id: 'm1', filename: 'logo.png', expires_in: 300 }
    : { ok: true });
  const tool = mediaTools.find(item => item.name === 'upload_media_inline')!;
  const result = await tool.handler({ filename: 'logo', content_type: 'image/png', data_base64: Buffer.from('png').toString('base64') } as never,
    { client: { post } as unknown as TyperollClient, siteId: 'site' });
  expect(JSON.parse(result.content[0]!.text)).toMatchObject({ media_id: 'm1', filename: 'logo.png' });
});
