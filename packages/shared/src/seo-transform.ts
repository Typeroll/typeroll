/**
 * Post-save body transforms that nudge the HTML toward better SEO + Core
 * Web Vitals without surprising the editor:
 *
 *   - Adds loading="lazy" + decoding="async" to every <img> except the
 *     first one (LCP candidate gets eager loading).
 *   - Injects width/height on <img> when missing AND the URL matches a
 *     known Media doc with stored dimensions. Avoids CLS.
 *   - Optionally wraps <img> in <picture> with Cloudflare Image Resizing
 *     srcset variants when the CDN is on Cloudflare. Gated by env var so
 *     non-CF deployments don't get broken URLs.
 *
 * The transform is idempotent: running it on already-transformed HTML
 * leaves it untouched. That matters because the page PUT handler stores
 * the transformed body, and a re-save shouldn't accumulate attributes.
 */

import type { Media, MediaVariant } from '@typeroll/shared';

interface MediaLookupEntry {
  width?: number;
  height?: number;
  alt?: string;
  /** Pre-generated AVIF/WebP/JPEG variants at responsive widths, produced
   *  by `lib/image-variants.ts` and stored on the Media doc. When present,
   *  the transform emits a `<picture>` block with `<source>` for each
   *  format so browsers pick the smallest supported variant. */
  variants?: MediaVariant[];
}

interface MediaLookup {
  /** cdn_url → media metadata for known media docs on this site. */
  byUrl: Map<string, MediaLookupEntry>;
}

export function buildMediaLookup(media: Media[]): MediaLookup {
  const byUrl = new Map<string, MediaLookupEntry>();
  for (const m of media) {
    if (!m.cdn_url) continue;
    byUrl.set(m.cdn_url, {
      width: m.width,
      height: m.height,
      alt: m.alt_text,
      variants: m.variants,
    });
  }
  return { byUrl };
}

const CF_RESIZE_WIDTHS = [400, 800, 1200, 1600];

/**
 * Last-resort `sizes` value baked into generated `<picture><source>` when the
 * author hasn't set `sizes` on the `<img>` and no per-page/per-site default is
 * configured. Deliberately generic: full viewport on phones, 800px on larger
 * screens. For container-constrained images this over-fetches (a 360px-wide
 * hero pulls the 640w variant) — that's exactly what `defaultSizes` (per-page /
 * per-site) and a per-image `sizes` attribute exist to correct.
 */
export const DEFAULT_IMAGE_SIZES = '(max-width: 768px) 100vw, 800px';

export interface TransformOptions {
  /** Cloudflare-hosted CDN origin (e.g. "https://cdn.example.com"). When set,
   *  <img src> on this origin get wrapped in <picture> with /cdn-cgi/image/
   *  srcset variants. Optional. */
  cfImageOrigin?: string;
  /**
   * Default `sizes` for generated `<picture><source>` elements, used when the
   * source `<img>` has no `sizes` of its own. Callers resolve this from the
   * page's `image_sizes_default` falling back to the site setting. The
   * precedence the transform applies is:
   *   per-image `sizes` attr  >  this `defaultSizes`  >  DEFAULT_IMAGE_SIZES.
   * Lets container-constrained images (e.g. a 360px hero) advertise their real
   * rendered width so the browser picks the 320w variant instead of 640w.
   */
  defaultSizes?: string;
}

/**
 * Transform a page body in place. Returns the modified HTML; never throws.
 * Designed to be cheap (~ms for realistic pages).
 */
export function transformBodyForSeo(
  html: string,
  lookup: MediaLookup,
  opts: TransformOptions = {},
): string {
  if (!html) return html;
  let imgIndex = 0;

  // Single pass over <img> tags. Don't re-wrap an <img> that is already
  // inside a <picture> — whether one WE emitted on a previous pass
  // (idempotency) or one the AUTHOR hand-wrote to opt out of the generic
  // sizes (e.g. custom media-queried <source>s). Re-wrapping produced
  // invalid nested <picture> markup — see the autopilot.se field report.
  return html.replace(/<img\b([^>]*)\/?>/gi, (match, attrsRaw, offset) => {
    // Are we inside an open <picture>? Find the nearest preceding picture
    // boundary across the WHOLE prefix (not a fixed 200-char window — an
    // author's <picture> with several long media-queried <source>s pushes
    // the opening tag well past 200 chars, which is exactly the case that
    // slipped through before and produced nested <picture>). We're inside
    // when the last "<picture" opener comes after the last "</picture>".
    const before = html.slice(0, offset);
    const lastOpen = before.lastIndexOf('<picture');
    const lastClose = before.lastIndexOf('</picture>');
    const insidePicture = lastOpen > lastClose;

    const attrs = parseAttrs(attrsRaw);
    const index = imgIndex++;
    const isLeading = index < 2; // first ~2 imgs probably above-the-fold

    // 1. loading / decoding defaults.
    if (!('loading' in attrs)) attrs.loading = isLeading ? 'eager' : 'lazy';
    if (!('decoding' in attrs)) attrs.decoding = 'async';
    if (isLeading && !('fetchpriority' in attrs)) attrs.fetchpriority = 'high';

    // 2. width/height + alt injection from Media lookup.
    const src = attrs.src;
    if (src) {
      const meta = lookup.byUrl.get(src);
      if (meta) {
        if (!('width' in attrs) && meta.width) attrs.width = String(meta.width);
        if (!('height' in attrs) && meta.height) attrs.height = String(meta.height);
        // Don't overwrite an existing alt (even empty — author may have meant it).
        if (attrs.alt === undefined && meta.alt) attrs.alt = meta.alt;
      }
    }

    // 3. Pre-generated R2 variants — emit a <picture> with AVIF + WebP
    //    sources. This is the path Typeroll itself uses: `lib/image-variants.ts`
    //    builds 320/640/1024/1920 widths × {avif,webp} on R2, the Media
    //    doc carries them in `variants`, and we wrap the original <img>
    //    in <picture> so modern browsers pick the smallest matching
    //    format/width. Saves ~70-90% on byte transfer for large PNGs.
    if (!insidePicture && src) {
      const meta = lookup.byUrl.get(src);
      if (meta?.variants && meta.variants.length > 0) {
        const sizes = attrs.sizes ?? opts.defaultSizes ?? DEFAULT_IMAGE_SIZES;
        const sources: string[] = [];
        // <source> order matters: browsers pick the first they support.
        // AVIF first (smallest), then WebP, then fall through to <img>.
        for (const fmt of ['avif', 'webp'] as const) {
          const srcset = buildVariantSrcset(meta.variants, fmt);
          if (srcset) {
            sources.push(`<source type="image/${fmt}" srcset="${escapeAttr(srcset)}" sizes="${escapeAttr(sizes)}" />`);
          }
        }
        if (sources.length > 0) {
          const rebuilt = serializeImg(attrs);
          return `<picture>${sources.join('')}${rebuilt}</picture>`;
        }
      }
    }

    // 4. Cloudflare Image Resizing srcset wrap — fallback for sites that
    //    haven't generated R2 variants yet but DO have CF Image Resizing
    //    enabled on their CDN origin.
    if (!insidePicture && opts.cfImageOrigin && src && src.startsWith(opts.cfImageOrigin)) {
      const rebuilt = serializeImg(attrs);
      const srcset = CF_RESIZE_WIDTHS.map((w) => {
        const variant = `${opts.cfImageOrigin!.replace(/\/$/, '')}/cdn-cgi/image/width=${w},format=auto/${src.slice(opts.cfImageOrigin!.length).replace(/^\//, '')}`;
        return `${variant} ${w}w`;
      }).join(', ');
      const sizes = attrs.sizes ?? opts.defaultSizes ?? DEFAULT_IMAGE_SIZES;
      return `<picture><source type="image/webp" srcset="${escapeAttr(srcset)}" sizes="${escapeAttr(sizes)}" />${rebuilt}</picture>`;
    }

    return serializeImg(attrs);
  });
}

/**
 * Build an `srcset` value filtered to a single format. Sorted ascending
 * by width so the browser's selection logic works as expected (it
 * iterates and picks the first wide enough for the viewport).
 */
function buildVariantSrcset(
  variants: MediaVariant[],
  format: MediaVariant['format'],
): string | null {
  const matching = variants
    .filter((v) => v.format === format)
    .sort((a, b) => a.width - b.width);
  if (matching.length === 0) return null;
  return matching.map((v) => `${v.cdn_url} ${v.width}w`).join(', ');
}

/**
 * Scan the body for accessibility/SEO issues that we can't auto-fix.
 * Returns warning strings the editor can surface to the user.
 */
export function lintBodyForSeo(html: string): string[] {
  const warnings: string[] = [];
  if (!html) return warnings;

  let missingAlt = 0;
  let totalImg = 0;
  for (const m of html.matchAll(/<img\b([^>]*)\/?>/gi)) {
    totalImg++;
    const attrs = parseAttrs(m[1]);
    // alt="" is intentional (decorative). Only flag when alt is missing
    // entirely. role="presentation" / aria-hidden="true" also exempt.
    if (
      attrs.alt === undefined &&
      attrs['aria-hidden'] !== 'true' &&
      attrs.role !== 'presentation'
    ) {
      missingAlt++;
    }
  }
  if (missingAlt > 0) {
    warnings.push(
      `${missingAlt} of ${totalImg} images are missing alt text. Add a description or mark them aria-hidden="true" if decorative.`,
    );
  }

  // Multiple <h1>: should be exactly one per page.
  const h1Count = (html.match(/<h1\b/gi) ?? []).length;
  if (h1Count === 0) {
    warnings.push('No <h1> on this page. Every page should have exactly one top-level heading.');
  } else if (h1Count > 1) {
    warnings.push(`Found ${h1Count} <h1> elements — there should be only one per page.`);
  }

  // Empty links — usually a sign of a broken template insertion.
  const emptyLinks = (html.match(/<a\b[^>]*>\s*<\/a>/gi) ?? []).length;
  if (emptyLinks > 0) {
    warnings.push(`${emptyLinks} link(s) have no text content. Search engines and screen readers can't follow them.`);
  }

  return warnings;
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function parseAttrs(raw: string): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  // Quoted, then unquoted, then bare boolean.
  const re = /([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const key = m[1].toLowerCase();
    out[key] = m[2] ?? m[3] ?? m[4] ?? '';
  }
  return out;
}

function serializeImg(attrs: Record<string, string | undefined>): string {
  const order = ['src', 'srcset', 'sizes', 'alt', 'width', 'height', 'loading', 'decoding', 'fetchpriority'];
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const k of order) {
    if (k in attrs) {
      parts.push(formatAttr(k, attrs[k]));
      seen.add(k);
    }
  }
  for (const [k, v] of Object.entries(attrs)) {
    if (!seen.has(k)) parts.push(formatAttr(k, v));
  }
  return `<img ${parts.join(' ')} />`;
}

function formatAttr(k: string, v: string | undefined): string {
  if (v === undefined || v === '') return k;
  return `${k}="${escapeAttr(v)}"`;
}

function escapeAttr(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}
