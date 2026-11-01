// sitemap.xml entries, shared by the single sitemap and, for very large
// sites, the numbered sitemaps behind a sitemap index.

import { resolveAlternates } from '@typeroll/shared';
import { getSiteSettings, isVersionRobotsBlocked } from './content';
import { getSiteRoutes } from './routes';

/** Below the protocol's 50,000-URL limit, with room for growth between builds. */
export const SITEMAP_MAX_URLS = 45_000;
export const XHTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';

export function escapeXml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

export interface SitemapEntries { entries: string[]; hreflang: boolean }

export async function sitemapEntries(base: string): Promise<SitemapEntries> {
  const routes = await getSiteRoutes();
  const settings = await getSiteSettings();
  const blocked = settings.sitewide_noindex || await isVersionRobotsBlocked();
  let hreflang = false;
  const entries = (blocked ? [] : routes)
    .filter(({ props }) => props.page.status === 'published' && !props.page.noindex)
    .map(({ params, props }) => {
      const p = props.page;
      const pageNum = (props as { pageNum?: number }).pageNum;
      const path = params.slug ? `/${params.slug}${settings.trailing_slash === 'never' ? '' : '/'}` : '/';
      const loc = `${base}${path}`;
      // lastmod_override: explicit string wins; empty string suppresses
      // lastmod entirely; undefined falls back to the timestamps. Editors
      // use this to avoid bumping freshness on minor edits.
      const lastmod =
        p.lastmod_override === ''
          ? ''
          : p.lastmod_override ?? (p.date_updated || p.date_published);
      // The page's own hreflang cluster, as in its <head>. Archive pages
      // (/page/2/) and facets are not part of a cluster.
      const alternates = pageNum ? [] : resolveAlternates(p.alternates, p.canonical_url || loc, p.language || settings.language || 'en');
      if (alternates.length) hreflang = true;
      return [
        '<url>',
        `<loc>${escapeXml(loc)}</loc>`,
        lastmod ? `<lastmod>${escapeXml(lastmod)}</lastmod>` : '',
        ...alternates.map(a => `<xhtml:link rel="alternate" hreflang="${escapeXml(a.hreflang)}" href="${escapeXml(a.href)}"/>`),
        '</url>',
      ]
        .filter(Boolean)
        .join('');
    });
  return { entries, hreflang };
}

export function urlset(entries: string[], hreflang: boolean): string {
  const namespaces = `xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"${hreflang ? ` xmlns:xhtml="${XHTML_NAMESPACE}"` : ''}`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset ${namespaces}>${entries.join('')}</urlset>`;
}

export function sitemapIndex(base: string, count: number): string {
  const items = Array.from({ length: count }, (_, index) => `<sitemap><loc>${escapeXml(`${base}/sitemap-${index + 1}.xml`)}</loc></sitemap>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${items}</sitemapindex>`;
}
