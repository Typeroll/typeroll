import { describe, expect, it } from 'vitest';
import { readSitemap } from '../../lib/wp/sitemap';

describe('readSitemap', () => {
  it('recursively reads indexes, resolves relative children, and deduplicates URLs', async () => {
    const responses: Record<string, string> = {
      'https://old.example.com/sitemap.xml': '<sitemapindex><sitemap><loc>/posts.xml</loc></sitemap><sitemap><loc>/pages.xml</loc></sitemap></sitemapindex>',
      'https://old.example.com/posts.xml': '<urlset><url><loc>https://old.example.com/a</loc></url></urlset>',
      'https://old.example.com/pages.xml': '<urlset><url><loc>https://old.example.com/a</loc></url><url><loc>https://old.example.com/b</loc><lastmod>2026-01-01</lastmod></url></urlset>',
    };
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const value = responses[String(input)];
      return value ? new Response(value, { status: 200 }) : new Response('', { status: 404 });
    }) as typeof fetch;
    const result = await readSitemap('https://old.example.com/sitemap.xml', { fetchImpl });
    expect(result.sitemaps_read).toBe(3);
    expect(result.urls).toEqual([
      { loc: 'https://old.example.com/a', lastmod: undefined },
      { loc: 'https://old.example.com/b', lastmod: '2026-01-01' },
    ]);
  });
});
