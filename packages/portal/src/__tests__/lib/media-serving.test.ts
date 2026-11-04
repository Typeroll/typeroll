// The image check after a publication: which images a page references, and
// which answers count as "not served". The real module is used here; the test
// setup replaces it everywhere else so no test reaches the network.
import { describe, expect, it, vi } from 'vitest';

const real = await vi.importActual<typeof import('../../lib/publishing/media-serving')>('../../lib/publishing/media-serving');
const page = '<html><head><meta property="og:image" content="https://media.example.org/share.png"></head><body>'
  + '<picture><source type="image/avif" srcset="https://media.example.org/a.png.w320.avif 320w, https://media.example.org/a.png.w640.avif 640w" />'
  + '<img src="https://media.example.org/a.png" alt="" /></picture><img src="/media/b.png" alt="" /><img src="data:image/png;base64,AA" alt="" /></body></html>';
const html = async () => new Response(page, { status: 200 });

describe('image check after publication', () => {
  it('lists the share image, each img and the first srcset candidate once, resolving relative paths', () => {
    expect(real.referencedImageUrls(page, 'https://site.example/')).toEqual([
      'https://media.example.org/share.png', 'https://media.example.org/a.png.w320.avif', 'https://media.example.org/a.png', 'https://site.example/media/b.png']);
  });

  it('reports images that answer 404 or whose host does not resolve', async () => {
    const result = await real.checkLiveMedia('site.example', { fetchPage: html as never, fetchMedia: (async (url: string) => {
      if (url.includes('share.png')) throw new TypeError('getaddrinfo ENOTFOUND media.example.org');
      return new Response(null, { status: url.endsWith('/b.png') ? 404 : 200 });
    }) as never });
    expect(result.status).toBe('failing');
    expect(result.checked).toBe(4);
    expect(result.failing.map(entry => [entry.url, entry.http_status])).toEqual([['https://media.example.org/share.png', null], ['https://site.example/media/b.png', 404]]);
  });

  it('treats edge errors, rate limits and timeouts as inconclusive, not as failures', async () => {
    const edge = await real.checkLiveMedia('site.example', { fetchPage: html as never, fetchMedia: (async () => new Response(null, { status: 503 })) as never });
    expect(edge).toMatchObject({ status: 'inconclusive', failing: [] });
    const timeout = await real.checkLiveMedia('site.example', { fetchPage: html as never, fetchMedia: (async () => { throw new Error('The operation timed out'); }) as never });
    expect(timeout.status).toBe('inconclusive');
    const ok = await real.checkLiveMedia('site.example', { fetchPage: html as never, fetchMedia: (async () => new Response(null, { status: 200 })) as never });
    expect(ok).toMatchObject({ status: 'serving', checked: 4, failing: [] });
  });
});
