import type { APIRoute } from 'astro';
import { SITEMAP_MAX_URLS, sitemapEntries, sitemapIndex, urlset } from '../lib/sitemap';

// One sitemap for ordinary sites. Past SITEMAP_MAX_URLS this becomes a
// sitemap index over /sitemap-1.xml, /sitemap-2.xml, … (see
// sitemap-[n].xml.ts), so robots.txt keeps pointing at /sitemap.xml.
export const GET: APIRoute = async ({ site }) => {
  const base = site ? site.toString().replace(/\/$/, '') : '';
  const { entries, hreflang } = await sitemapEntries(base);
  const xml = entries.length > SITEMAP_MAX_URLS
    ? sitemapIndex(base, Math.ceil(entries.length / SITEMAP_MAX_URLS))
    : urlset(entries, hreflang);
  return new Response(xml, {
    headers: { 'Content-Type': 'application/xml; charset=utf-8' },
  });
};
