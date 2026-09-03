import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TyperollClient } from '../src/client.js';
import { mediaTools } from '../src/tools/media.js';

afterEach(() => vi.unstubAllGlobals());

describe('upload_media_batch_from_urls', () => {
  it('keeps input order, finalizes successes and reports per-item failures', async () => {
    const post = vi.fn(async (_site: string, path: string, body?: Record<string, unknown>) => {
      if (path === 'media/upload-url') {
        const filename = String(body?.filename);
        return { upload_url: `https://upload.test/${filename}`, cdn_url: `https://cdn.test/${filename}`, media_id: filename, key: filename, expires_in: 300 };
      }
      return { finalized: true };
    });
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('broken.jpg')) return new Response('no', { status: 404 });
      return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'image/jpeg' } });
    }));
    const tool = mediaTools.find((candidate) => candidate.name === 'upload_media_batch_from_urls')!;
    const result = await tool.handler({ items: [
      { source_url: 'https://source.test/first.jpg' },
      { source_url: 'https://source.test/broken.jpg' },
      { source_url: 'https://source.test/third.jpg' },
    ] } as never, { client: { post } as unknown as TyperollClient, siteId: 'site' });
    const payload = JSON.parse(result.content[0]!.text);
    expect(payload.results.map((entry: { source_url: string }) => entry.source_url)).toEqual([
      'https://source.test/first.jpg', 'https://source.test/broken.jpg', 'https://source.test/third.jpg',
    ]);
    expect(payload).toMatchObject({ succeeded: 2, failed: 1 });
    expect(post.mock.calls.filter((call) => String(call[1]).endsWith('/finalize'))).toHaveLength(2);
  });

  it('rejects oversized sources before requesting an upload URL', async () => {
    const post = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1]), {
      status: 200,
      headers: { 'content-length': String(26 * 1024 * 1024), 'content-type': 'image/jpeg' },
    })));
    const tool = mediaTools.find((candidate) => candidate.name === 'upload_media_batch_from_urls')!;
    const result = await tool.handler({ items: [
      { source_url: 'https://source.test/too-large.jpg' },
    ] } as never, { client: { post } as unknown as TyperollClient, siteId: 'site' });
    const payload = JSON.parse(result.content[0]!.text);
    expect(payload).toMatchObject({ succeeded: 0, failed: 1 });
    expect(payload.results[0].error).toContain('Source file too large');
    expect(post).not.toHaveBeenCalled();
  });
});
