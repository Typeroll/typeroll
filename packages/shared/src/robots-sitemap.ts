/**
 * robots.txt sitemap discovery line management.
 *
 * The customer can write a fully custom robots.txt via site settings. We
 * still want crawlers to discover our generated sitemaps — Google in
 * particular only auto-fetches `/sitemap.xml`, so a custom robots that
 * forgets the `Sitemap:` line silently drops image-sitemap discovery
 * (and any future per-language sitemap variants).
 *
 * Rule: if the customer wrote their own `Sitemap:` line (any URL), trust
 * them and don't touch it. Otherwise, append our platform-managed lines.
 */

const SITEMAP_LINE_RE = /^\s*sitemap\s*:/im;

export function withSitemapLines(custom: string | undefined, sitemapUrls: string[]): string {
  const trimmed = (custom ?? '').trim();
  const lines = sitemapUrls.map((u) => `Sitemap: ${u}`).join('\n');
  if (trimmed.length === 0) {
    return `User-agent: *\nAllow: /\n\n${lines}\n`;
  }
  if (SITEMAP_LINE_RE.test(trimmed)) {
    return trimmed.endsWith('\n') ? trimmed : `${trimmed}\n`;
  }
  return `${trimmed}\n\n${lines}\n`;
}
