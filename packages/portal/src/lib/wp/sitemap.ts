// Sitemap discovery + parsing.
//
// WordPress and most CMSes expose one or more sitemaps. WP core 5.5+ has a
// built-in /wp-sitemap.xml; older sites used /sitemap.xml (Yoast, Rank Math,
// All in One SEO, etc.); some use /sitemap_index.xml as an index of nested
// sitemaps.
//
// This module walks the sitemap graph and returns every URL it can find,
// with the depth capped at a reasonable level to defend against pathological
// or malicious recursion.

const CANDIDATE_PATHS = [
  '/sitemap.xml',
  '/wp-sitemap.xml',
  '/sitemap_index.xml',
  '/sitemap-index.xml',
  '/sitemap_1.xml',
];

const MAX_DEPTH = 4;
const MAX_TOTAL_URLS = 50_000;

export interface SitemapUrl {
  loc: string;
  lastmod?: string;
}

/** Find a working sitemap on the source site and return every URL it lists. */
export async function discoverSitemap(siteBaseUrl: string): Promise<SitemapUrl[]> {
  const base = siteBaseUrl.replace(/\/$/, '');
  for (const path of CANDIDATE_PATHS) {
    const url = `${base}${path}`;
    try {
      const xml = await fetchXml(url);
      if (!xml) continue;
      const urls = await collectUrls(xml, base, 0);
      if (urls.length > 0) return urls.slice(0, MAX_TOTAL_URLS);
    } catch {
      /* try next */
    }
  }
  return [];
}

async function collectUrls(xml: string, base: string, depth: number): Promise<SitemapUrl[]> {
  if (depth > MAX_DEPTH) return [];

  // A sitemap can be either a `<urlset>` (final) or a `<sitemapindex>`
  // (pointers to other sitemaps). Both are XML with <loc> entries.
  const isIndex = /<sitemapindex\b/i.test(xml);

  if (isIndex) {
    const inner: SitemapUrl[] = [];
    for (const child of extractLocs(xml)) {
      if (inner.length >= MAX_TOTAL_URLS) break;
      try {
        const childXml = await fetchXml(child);
        if (!childXml) continue;
        const nested = await collectUrls(childXml, base, depth + 1);
        inner.push(...nested);
      } catch {
        /* skip broken child */
      }
    }
    return inner;
  }

  // urlset — pull loc + lastmod pairs.
  return extractEntries(xml);
}

function extractLocs(xml: string): string[] {
  const out: string[] = [];
  for (const m of xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)) {
    out.push(decodeXml(m[1].trim()));
  }
  return out;
}

function extractEntries(xml: string): SitemapUrl[] {
  const out: SitemapUrl[] = [];
  // Split by <url> blocks so we associate each loc with its sibling lastmod.
  for (const block of xml.split(/<url\b/gi).slice(1)) {
    const locMatch = block.match(/<loc>\s*([^<]+?)\s*<\/loc>/i);
    if (!locMatch) continue;
    const loc = decodeXml(locMatch[1].trim());
    const lastmodMatch = block.match(/<lastmod>\s*([^<]+?)\s*<\/lastmod>/i);
    out.push({ loc, lastmod: lastmodMatch ? lastmodMatch[1].trim() : undefined });
  }
  return out;
}

async function fetchXml(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/xml,text/xml;q=0.9' },
      signal: AbortSignal.timeout(15_000),
      redirect: 'follow',
    });
    if (!res.ok) return null;
    const text = await res.text();
    // Sanity: must contain at least one <loc>.
    if (!/<loc>/i.test(text)) return null;
    return text;
  } catch {
    return null;
  }
}

function decodeXml(s: string): string {
  return s
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'");
}
