// Pull every same-origin <a href> from an HTML fragment.
//
// Used by the URL inventory's coverage analyzer to find old-site links that
// might be referenced from imported pages but didn't appear in the sitemap
// or REST list.

export function extractInternalLinks(html: string, sourceOrigin: string): string[] {
  if (!html || !sourceOrigin) return [];
  const origin = sourceOrigin.replace(/\/$/, '');
  const out = new Set<string>();

  for (const m of html.matchAll(/<a\b[^>]*\bhref=("([^"]*)"|'([^']*)')/gi)) {
    const raw = (m[2] ?? m[3] ?? '').trim();
    if (!raw) continue;
    if (raw.startsWith('#')) continue;
    if (raw.startsWith('mailto:') || raw.startsWith('tel:') || raw.startsWith('javascript:')) continue;

    // Resolve to absolute against the source origin.
    let abs: string;
    if (raw.startsWith('//')) {
      abs = `${new URL(origin).protocol}${raw}`;
    } else if (raw.startsWith('/')) {
      abs = `${origin}${raw}`;
    } else if (/^https?:\/\//i.test(raw)) {
      abs = raw;
    } else {
      // Relative paths like "about" or "../foo" — skip; they could resolve
      // to anything depending on page slug context. The REST/sitemap pass
      // already covers these as canonical URLs.
      continue;
    }

    try {
      const u = new URL(abs);
      if (u.origin !== origin) continue; // external link, not our inventory
      const path = u.pathname + (u.search || '');
      out.add(path);
    } catch {
      /* skip */
    }
  }

  return Array.from(out);
}
