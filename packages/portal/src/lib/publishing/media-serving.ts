import { createSafeFetch } from '../net/safe-fetch';

/**
 * After a publication is live, read its home page and check that a sample of
 * the images it references (og:image, <img src>, the first candidate of each
 * srcset) answer 200, on every host they use. A publication that went live
 * with images on a host that does not serve them yet (an unattached media
 * host, a removed R2 custom domain, a broken path rule) is reported within
 * minutes instead of when a visitor notices. Read-only; it never changes
 * anything.
 */

export interface MediaServingFailure { url: string; http_status: number | null; error?: string }
export interface MediaServingResult {
  status: 'serving' | 'failing' | 'inconclusive';
  checked: number;
  failing: MediaServingFailure[];
  error?: string;
}

export const MEDIA_SAMPLE_SIZE = 12;
const pageFetch = createSafeFetch({ label: 'Media serving check', maxRedirects: 2, timeoutMs: 10_000, maxBytes: 2 * 1024 * 1024 });
const mediaFetch = createSafeFetch({ label: 'Media serving check', maxRedirects: 3, timeoutMs: 10_000, maxBytes: 64 * 1024 });
const decode = (value: string) => value.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');

/** Image URLs a page references, in document order, without duplicates. */
export function referencedImageUrls(html: string, pageUrl: string): string[] {
  const found: string[] = [];
  const add = (raw: string | undefined) => {
    if (!raw) return;
    try {
      const url = new URL(decode(raw.trim()), pageUrl);
      if (url.protocol === 'https:' && !found.includes(url.href)) found.push(url.href);
    } catch { /* not a URL */ }
  };
  add(/<meta\s+property="og:image"\s+content="([^"]+)"/i.exec(html)?.[1]);
  for (const match of html.matchAll(/<(img|source)\b[^>]*>/gi)) {
    const tag = match[0];
    add(/\ssrc="([^"]+)"/i.exec(tag)?.[1]);
    add(/\ssrcset="([^"]+)"/i.exec(tag)?.[1]?.split(',')[0]?.trim().split(/\s+/)[0]);
  }
  return found.filter(url => !url.startsWith('data:'));
}

export async function checkLiveMedia(websiteHost: string, opts: { fetchPage?: typeof fetch; fetchMedia?: typeof fetch; sample?: number } = {}): Promise<MediaServingResult> {
  const pageUrl = `https://${websiteHost}/`;
  let html: string;
  try {
    const response = await (opts.fetchPage ?? pageFetch)(pageUrl, { headers: { 'Cache-Control': 'no-cache', 'User-Agent': 'Typeroll-Serving-Check/1.0' } });
    if (!response.ok) return { status: 'inconclusive', checked: 0, failing: [], error: `The home page answered HTTP ${response.status}.` };
    html = await response.text();
  } catch (error) {
    return { status: 'inconclusive', checked: 0, failing: [], error: error instanceof Error ? error.message : 'The home page could not be read.' };
  }
  const urls = referencedImageUrls(html, pageUrl).slice(0, opts.sample ?? MEDIA_SAMPLE_SIZE);
  const results = await Promise.all(urls.map(async (url): Promise<MediaServingFailure | 'ok' | 'unknown'> => {
    try {
      const response = await (opts.fetchMedia ?? mediaFetch)(url, { method: 'HEAD', headers: { 'Cache-Control': 'no-cache', 'User-Agent': 'Typeroll-Serving-Check/1.0' } });
      void response.body?.cancel().catch(() => {});
      if (response.ok) return 'ok';
      // Edge errors and rate limits say nothing about the file itself.
      if (response.status === 429 || response.status >= 520) return 'unknown';
      return { url, http_status: response.status };
    } catch (error) {
      // A host that does not resolve or refuses TLS does not serve the file.
      const message = error instanceof Error ? error.message : 'The request failed.';
      return /timed? ?out|abort/i.test(message) ? 'unknown' : { url, http_status: null, error: message };
    }
  }));
  const failing = results.filter((result): result is MediaServingFailure => typeof result === 'object');
  const conclusive = results.filter(result => result !== 'unknown').length;
  return { status: failing.length ? 'failing' : conclusive ? 'serving' : 'inconclusive', checked: urls.length, failing };
}
