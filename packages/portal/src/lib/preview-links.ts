/**
 * Internal links in rendered preview HTML, as site-relative paths, so an API
 * caller can decide what to render next. Shared by the v1 page preview and
 * revision preview routes.
 */
export function extractInternalLinks(html: string, siteOrigin: string): string[] {
  if (!html) return [];
  const links = new Set<string>();
  const re = /<a\s[^>]*href=(?:"([^"]+)"|'([^']+)')/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const href = (m[1] ?? m[2] ?? '').trim();
    if (!href) continue;
    if (href.startsWith('/') && !href.startsWith('//')) links.add(href);
    else if (siteOrigin && href.startsWith(siteOrigin)) links.add(href.slice(siteOrigin.length) || '/');
  }
  return Array.from(links);
}
