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

export interface SitemapReadResult {
  urls: SitemapUrl[];
  sitemaps_read: number;
  errors: Array<{ url: string; error: string }>;
  truncated: boolean;
}

export interface SitemapReadOptions {
  fetchImpl?: typeof fetch;
  maxDepth?: number;
  maxUrls?: number;
  /** Optional SSRF guard run for the root, every child index and every HTTP
   * redirect before a request is sent. */
  validateUrl?: (url: URL) => void | Promise<void>;
}

/** Find a working sitemap on the source site and return every URL it lists. */
export async function discoverSitemap(siteBaseUrl: string): Promise<SitemapUrl[]> {
  const base = siteBaseUrl.replace(/\/$/, '');
  for (const path of CANDIDATE_PATHS) {
    const url = `${base}${path}`;
    try {
      const result = await readSitemap(url);
      if (result.urls.length > 0) return result.urls;
    } catch {
      /* try next */
    }
  }
  return [];
}

/** Read an explicitly supplied sitemap or sitemap index recursively. */
export async function readSitemap(
  sitemapUrl: string,
  opts: SitemapReadOptions = {},
): Promise<SitemapReadResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const maxDepth = opts.maxDepth ?? MAX_DEPTH;
  const maxUrls = opts.maxUrls ?? MAX_TOTAL_URLS;
  const errors: SitemapReadResult['errors'] = [];
  const seenSitemaps = new Set<string>();
  const byLocation = new Map<string, SitemapUrl>();

  let root: URL;
  try {
    root = new URL(sitemapUrl);
    if (root.protocol !== 'http:' && root.protocol !== 'https:') throw new Error('unsupported protocol');
  } catch {
    throw new Error('sitemap_url must be an absolute http(s) URL');
  }

  const visit = async (url: string, depth: number): Promise<void> => {
    if (depth > maxDepth || byLocation.size >= maxUrls || seenSitemaps.has(url)) return;
    seenSitemaps.add(url);
    const loaded = await fetchXml(url, fetchImpl, opts.validateUrl);
    if (!loaded.ok) {
      errors.push({ url, error: loaded.error });
      return;
    }
    const xml = loaded.xml;
    if (/<sitemapindex\b/i.test(xml)) {
      for (const child of extractLocs(xml)) {
        if (byLocation.size >= maxUrls) break;
        let resolved: string;
        try { resolved = new URL(child, url).toString(); }
        catch {
          errors.push({ url: child, error: 'invalid child sitemap URL' });
          continue;
        }
        await visit(resolved, depth + 1);
      }
      return;
    }
    for (const entry of extractEntries(xml)) {
      if (byLocation.size >= maxUrls) break;
      try {
        const loc = new URL(entry.loc, url).toString();
        byLocation.set(loc, { ...entry, loc });
      } catch {
        errors.push({ url: entry.loc, error: 'invalid URL entry' });
      }
    }
  };

  await visit(root.toString(), 0);
  return {
    urls: [...byLocation.values()],
    sitemaps_read: seenSitemaps.size,
    errors,
    truncated: byLocation.size >= maxUrls,
  };
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

async function fetchXml(
  url: string,
  fetchImpl: typeof fetch = fetch,
  validateUrl?: (url: URL) => void | Promise<void>,
): Promise<{ ok: true; xml: string } | { ok: false; error: string }> {
  try {
    let current = new URL(url);
    let res: Response | undefined;
    for (let redirects = 0; redirects <= 5; redirects++) {
      await validateUrl?.(current);
      res = await fetchImpl(current, {
        headers: { Accept: 'application/xml,text/xml;q=0.9' },
        signal: AbortSignal.timeout(15_000),
        redirect: 'manual',
      });
      if (res.status < 300 || res.status >= 400) break;
      const location = res.headers.get('location');
      if (!location) return { ok: false, error: 'redirect without Location' };
      current = new URL(location, current);
      if (redirects === 5) return { ok: false, error: 'too many redirects' };
    }
    if (!res) return { ok: false, error: 'empty response' };
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const text = await res.text();
    // Sanity: must contain at least one <loc>.
    if (!/<loc>/i.test(text)) return { ok: false, error: 'response is not a sitemap' };
    return { ok: true, xml: text };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
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
