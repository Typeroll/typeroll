import type { APIRoute } from 'astro';
import { getAllPages, getCollectionItemRoutes, urlFor } from '../lib/content';

export const GET: APIRoute = async ({ site }) => {
  const base = site ? site.toString().replace(/\/$/, '') : '';
  const pages = await getAllPages({ includeUnlisted: false });

  const pageEntries = pages
    .filter((p) => !p.noindex)
    .map((p) => {
      const loc = `${base}${urlFor(p)}`;
      // lastmod_override: explicit string wins; empty string suppresses
      // lastmod entirely; undefined falls back to the timestamps. Editors
      // use this to avoid bumping freshness on minor edits.
      const lastmod =
        p.lastmod_override === ''
          ? ''
          : p.lastmod_override ?? (p.date_updated || p.date_published);
      return [
        '<url>',
        `<loc>${escapeXml(loc)}</loc>`,
        lastmod ? `<lastmod>${escapeXml(lastmod)}</lastmod>` : '',
        '</url>',
      ]
        .filter(Boolean)
        .join('');
    })
    .join('');

  // Collection items with a route_template get their own sitemap rows.
  // Same noindex check as pages — an item with `noindex: true` field gets
  // skipped. Last-mod falls through item.updated_at → item.created_at.
  const itemRoutes = await getCollectionItemRoutes();
  const itemEntries = itemRoutes
    .filter(({ item }) => !(item as Record<string, unknown>).noindex)
    .map(({ path, item }) => {
      // Match astro.config trailingSlash: 'always' — buildCollectionRoutes
      // returns paths without the trailing slash. Sitemap should mirror
      // the canonical the renderer emits.
      const withSlash = path === '/' || path.endsWith('/') ? path : `${path}/`;
      const loc = `${base}${withSlash}`;
      const lastmod = item.updated_at ?? item.created_at;
      return [
        '<url>',
        `<loc>${escapeXml(loc)}</loc>`,
        lastmod ? `<lastmod>${escapeXml(lastmod)}</lastmod>` : '',
        '</url>',
      ].filter(Boolean).join('');
    })
    .join('');

  const entries = pageEntries + itemEntries;

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${entries}</urlset>`;

  return new Response(xml, {
    headers: { 'Content-Type': 'application/xml; charset=utf-8' },
  });
};

function escapeXml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}
