// Public-page fetcher used as a fallback when the WP REST API returns
// thin or empty `content.rendered` (common with page builders that ship
// markup client-side or render via shortcodes the REST layer doesn't run).
//
// Strategy: try plain `fetch()` first — fast, free, works on most sites.
// When it can't reach the page (4xx/5xx, network error, or the response
// looks bot-blocked) AND a scraping server is configured, retry through
// the scraper. If neither works, return null and let the caller fall back
// to whatever REST gave us.

import { isScraperConfigured, Scraper } from './scraper';

export interface FetchedPage {
  url: string;
  html: string;
  source: 'fetch' | 'scraper';
}

const FETCH_TIMEOUT_MS = 15_000;
const MIN_HTML_LENGTH = 500;
const BOT_BLOCK_HINTS = [
  'cf-browser-verification',
  'Just a moment...',
  'cloudflare',
  'distil_r_captcha',
  'captcha',
  'Access denied',
  'Please enable JavaScript',
];

export async function fetchRendered(url: string): Promise<FetchedPage | null> {
  // Plain fetch first.
  const direct = await tryDirectFetch(url);
  if (direct) return direct;

  // Scraper fallback.
  if (isScraperConfigured()) {
    try {
      const scraper = new Scraper();
      const r = await scraper.scrape(url);
      return { url, html: r.html, source: 'scraper' };
    } catch {
      return null;
    }
  }
  return null;
}

async function tryDirectFetch(url: string): Promise<FetchedPage | null> {
  try {
    const res = await fetch(url, {
      headers: {
        // Use a common browser UA — many sites return a stripped page to
        // bare-bones user agents.
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const html = await res.text();
    if (html.length < MIN_HTML_LENGTH) return null;
    if (looksBotBlocked(html)) return null;
    return { url, html, source: 'fetch' };
  } catch {
    return null;
  }
}

function looksBotBlocked(html: string): boolean {
  const lc = html.toLowerCase();
  return BOT_BLOCK_HINTS.some((s) => lc.includes(s.toLowerCase()));
}

/**
 * Pull just the article / main content area from a full HTML document.
 * Used when we have a scraped public page and want to extract the real
 * content without theme chrome (header, footer, sidebar, comments).
 *
 * Heuristic, in priority order:
 *   1. <article>
 *   2. <main>
 *   3. <div id="content" / "main" / "primary">
 *   4. <div class="entry-content" / "post-content" / "page-content">
 *   5. fallback to the whole <body>
 */
export function extractMainContent(html: string): string {
  const tries: Array<RegExp> = [
    /<article\b[^>]*>([\s\S]*?)<\/article>/i,
    /<main\b[^>]*>([\s\S]*?)<\/main>/i,
    /<div\b[^>]*\bid="(?:content|main|primary)"[^>]*>([\s\S]*?)<\/div>\s*(?:<\/div>\s*)*(?=<footer|<\/body)/i,
    /<div\b[^>]*\bclass="[^"]*\b(?:entry-content|post-content|page-content)\b[^"]*"[^>]*>([\s\S]*?)<\/div>\s*(?:<\/div>\s*)*(?=<footer|<\/body)/i,
    /<body\b[^>]*>([\s\S]*?)<\/body>/i,
  ];
  for (const re of tries) {
    const m = html.match(re);
    if (m && m[1].trim().length > 200) return m[1];
  }
  return html;
}
