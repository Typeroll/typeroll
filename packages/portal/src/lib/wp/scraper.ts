// Pluggable scraper client.
//
// We have rich content via the WP REST API but many sites hide custom fields,
// don't expose featured images inline, or render content client-side. When
// configured, the scraper fetches the rendered public page as a fallback /
// supplement to REST.
//
// Configuration:
//   SCRAPER_API_URL   — endpoint of the scraping service
//   SCRAPER_API_KEY   — optional bearer / api key
//   SCRAPER_FORMAT    — "get" (default) or "post"
//                       get:  GET {SCRAPER_API_URL}?url={url}&key={key}
//                       post: POST {SCRAPER_API_URL} with JSON {url}, key in
//                             Authorization header
//   SCRAPER_RESPONSE_PATH — JSON path to the HTML in the response body, when
//                           the response is JSON (e.g. "data.html"). When
//                           unset, the response body is treated as HTML.
//
// The interface is intentionally minimal — point this at Browserless,
// ScrapingBee, your own Puppeteer wrapper, or anything else. If the env
// vars aren't set, isScraperConfigured() returns false and the caller
// degrades to REST-only.

export interface ScrapeResult {
  url: string;
  html: string;
  status: number;
  fetched_at: string;
}

export function isScraperConfigured(): boolean {
  return Boolean(process.env.SCRAPER_API_URL);
}

export class Scraper {
  private endpoint: string;
  private apiKey?: string;
  private format: 'get' | 'post';
  private responsePath?: string;

  constructor() {
    const url = process.env.SCRAPER_API_URL;
    if (!url) throw new Error('SCRAPER_API_URL is not configured');
    this.endpoint = url;
    this.apiKey = process.env.SCRAPER_API_KEY || undefined;
    this.format = (process.env.SCRAPER_FORMAT?.toLowerCase() === 'post' ? 'post' : 'get');
    this.responsePath = process.env.SCRAPER_RESPONSE_PATH || undefined;
  }

  async scrape(url: string): Promise<ScrapeResult> {
    const res = await this.callScraper(url);
    if (!res.ok) {
      throw new Error(`Scraper failed for ${url}: ${res.status} ${res.statusText}`);
    }
    const contentType = res.headers.get('content-type') ?? '';
    let html: string;
    if (contentType.includes('application/json')) {
      const body = await res.json();
      html = this.responsePath ? extractByPath(body, this.responsePath) : (body as { html?: string }).html ?? '';
    } else {
      html = await res.text();
    }
    if (!html || typeof html !== 'string') {
      throw new Error(`Scraper returned no HTML for ${url}`);
    }
    return {
      url,
      html,
      status: res.status,
      fetched_at: new Date().toISOString(),
    };
  }

  private callScraper(url: string): Promise<Response> {
    const signal = AbortSignal.timeout(30_000);
    if (this.format === 'post') {
      return fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify({ url }),
        signal,
      });
    }
    // GET (default)
    const u = new URL(this.endpoint);
    u.searchParams.set('url', url);
    if (this.apiKey) u.searchParams.set('key', this.apiKey);
    return fetch(u, { signal });
  }
}

function extractByPath(obj: unknown, dotPath: string): string {
  const parts = dotPath.split('.');
  let cur: unknown = obj;
  for (const part of parts) {
    if (cur && typeof cur === 'object') {
      cur = (cur as Record<string, unknown>)[part];
    } else {
      return '';
    }
  }
  return typeof cur === 'string' ? cur : '';
}
