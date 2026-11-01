import type { APIRoute, GetStaticPaths } from 'astro';
import { SITEMAP_MAX_URLS, sitemapEntries, urlset } from '../lib/sitemap';

// Numbered sitemaps behind the sitemap index. Only sites with more than
// SITEMAP_MAX_URLS indexable addresses get any.
export const getStaticPaths: GetStaticPaths = async () => {
  const base = (process.env.TYPEROLL_SITE_URL || 'https://example.com').replace(/\/$/, '');
  const { entries, hreflang } = await sitemapEntries(base);
  if (entries.length <= SITEMAP_MAX_URLS) return [];
  const count = Math.ceil(entries.length / SITEMAP_MAX_URLS);
  return Array.from({ length: count }, (_, index) => ({
    params: { n: String(index + 1) },
    props: { entries: entries.slice(index * SITEMAP_MAX_URLS, (index + 1) * SITEMAP_MAX_URLS), hreflang },
  }));
};

export const GET: APIRoute = async ({ props }) => {
  const { entries, hreflang } = props as { entries: string[]; hreflang: boolean };
  return new Response(urlset(entries, hreflang), {
    headers: { 'Content-Type': 'application/xml; charset=utf-8' },
  });
};
