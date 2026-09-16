import type { APIRoute } from 'astro';
import { getSiteSettings } from '../lib/content';

import { getSiteRoutes } from '../lib/routes';

export const GET: APIRoute = async ({ site }) => {
  const base = site ? site.toString().replace(/\/$/, '') : '';
  const routes = await getSiteRoutes();
  const settings = await getSiteSettings();

  const pageEntries = routes
    .filter(({ props }) => props.page.status === 'published' && !props.page.noindex)
    .map(({ params, props: { page: p } }) => {
      const path = params.slug ? `/${params.slug}${settings.trailing_slash === 'never' ? '' : '/'}` : '/';
      const loc = `${base}${path}`;
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

  const entries = pageEntries;

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
