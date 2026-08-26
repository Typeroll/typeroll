// Extract every image URL referenced by an HTML fragment.
//
// Used by the migration to know which images need to be moved to the new
// CDN per-page (just-in-time), instead of pre-fetching the entire WP
// media library. Looks at <img src>, <img srcset>, <source srcset>,
// background-image: url(...) in inline styles, and <link rel="preload"
// as="image">.
//
// Only returns URLs whose origin is `sourceOrigin` (defaults to "all
// origins" if not provided) — we don't want to ingest random hot-linked
// images from third-party CDNs.

export interface ExtractedImage {
  url: string;
  /** alt text captured from the <img alt="..."> attribute, if any */
  alt?: string;
}

export interface ExtractOptions {
  /** Only return images whose URL starts with this origin (e.g. "https://oldsite.com"). */
  sourceOrigin?: string;
}

export function extractImageUrls(html: string, opts: ExtractOptions = {}): ExtractedImage[] {
  if (!html) return [];

  const seen = new Map<string, ExtractedImage>();
  const add = (url: string, alt?: string) => {
    if (!url) return;
    if (url.startsWith('data:')) return;
    if (opts.sourceOrigin && !url.startsWith(opts.sourceOrigin)) return;
    const existing = seen.get(url);
    if (!existing || (!existing.alt && alt)) seen.set(url, { url, alt });
  };

  // <img src="..." alt="...">  — capture alt too
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0];
    const src = matchAttr(tag, 'src');
    const alt = matchAttr(tag, 'alt');
    if (src) add(src, alt ?? undefined);
    const srcset = matchAttr(tag, 'srcset');
    if (srcset) {
      for (const part of srcset.split(',')) {
        const url = part.trim().split(/\s+/)[0];
        add(url, alt ?? undefined);
      }
    }
  }

  // <source srcset="...">
  for (const m of html.matchAll(/<source\b[^>]*>/gi)) {
    const tag = m[0];
    const srcset = matchAttr(tag, 'srcset');
    if (srcset) {
      for (const part of srcset.split(',')) {
        const url = part.trim().split(/\s+/)[0];
        add(url);
      }
    }
    const src = matchAttr(tag, 'src');
    if (src) add(src);
  }

  // <link rel="preload" as="image" href="..."> — used by some themes
  for (const m of html.matchAll(/<link\b[^>]*\brel=["']?preload["']?[^>]*>/gi)) {
    const tag = m[0];
    if (!/\bas=["']?image["']?/i.test(tag)) continue;
    const href = matchAttr(tag, 'href');
    if (href) add(href);
  }

  // background-image: url(...) inside inline style attrs
  for (const m of html.matchAll(/style="[^"]*"|style='[^']*'/gi)) {
    const styleStr = m[0];
    for (const u of styleStr.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi)) {
      add(u[2]);
    }
  }

  return Array.from(seen.values());
}

function matchAttr(tag: string, attr: string): string | null {
  // Match both single- and double-quoted attributes.
  const re = new RegExp(`\\b${attr}=("([^"]*)"|'([^']*)')`, 'i');
  const m = tag.match(re);
  return m ? (m[2] ?? m[3] ?? null) : null;
}
