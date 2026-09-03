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

export interface SourceRedirectResolverOptions {
  fetchImpl?: typeof fetch;
  cache?: Map<string, Promise<string>>;
  timeoutMs?: number;
}

/** Resolve same-origin source links before reconstruction. WordPress sites
 * often keep renamed pages alive through a redirect plugin; carrying the
 * stale href into the new site would recreate a broken internal link. */
export async function resolveSourceRedirectsInHtml(
  html: string,
  sourceOrigin: string,
  opts: SourceRedirectResolverOptions = {},
): Promise<string> {
  if (!html || !sourceOrigin) return html;
  const origin = new URL(sourceOrigin).origin;
  const cache = opts.cache ?? new Map<string, Promise<string>>();
  const fetchImpl = opts.fetchImpl ?? fetch;
  const matches = [...html.matchAll(/<a\b[^>]*\bhref=("([^"]*)"|'([^']*)')/giu)];
  const replacements = new Map<string, string>();

  await Promise.all(matches.map(async (match) => {
    const raw = (match[2] ?? match[3] ?? '').trim();
    if (!raw || raw.startsWith('#') || /^(mailto|tel|javascript):/iu.test(raw)) return;
    let absolute: URL;
    try { absolute = new URL(raw, origin); } catch { return; }
    if (absolute.origin !== origin) return;
    absolute.hash = '';
    const key = absolute.toString();
    let pending = cache.get(key);
    if (!pending) {
      pending = resolveOne(key, origin, fetchImpl, opts.timeoutMs ?? 10_000);
      cache.set(key, pending);
    }
    const resolved = await pending;
    if (resolved !== key) replacements.set(raw, resolved);
  }));

  if (replacements.size === 0) return html;
  return html.replace(
    /(<a\b[^>]*\bhref=)(["'])([^"']*)(\2)/giu,
    (whole, prefix: string, quote: string, href: string) => {
      const replacement = replacements.get(href);
      return replacement ? `${prefix}${quote}${replacement}${quote}` : whole;
    },
  );
}

async function resolveOne(
  url: string,
  sourceOrigin: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<string> {
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'user-agent': 'Typeroll-Migration/1.0' },
    });
    void response.body?.cancel?.().catch(() => {});
    if (!response.ok || !response.redirected) return url;
    const final = new URL(response.url);
    final.hash = '';
    return final.origin === sourceOrigin ? `${final.pathname}${final.search}` : url;
  } catch {
    return url;
  }
}
