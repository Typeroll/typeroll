import { describe, it, expect } from 'vitest';
import { buildMediaLookup, transformBodyForSeo, lintBodyForSeo } from '../../lib/seo-transform';
import type { Media } from '@typeroll/shared';

function media(over: Partial<Media>): Media {
  return {
    id: 'm1',
    cdn_url: 'https://cdn.example.com/x.png',
    filename: 'x.png',
    ...over,
  } as Media;
}

describe('transformBodyForSeo', () => {
  it('adds loading=eager + fetchpriority=high to the first image, lazy to the rest', () => {
    const html = '<img src="https://cdn.example.com/1.png"><p>x</p><img src="https://cdn.example.com/2.png"><img src="https://cdn.example.com/3.png">';
    const out = transformBodyForSeo(html, buildMediaLookup([]));
    const matches = Array.from(out.matchAll(/<img\b[^>]*>/g)).map((m) => m[0]);
    expect(matches[0]).toContain('loading="eager"');
    expect(matches[0]).toContain('fetchpriority="high"');
    expect(matches[1]).toContain('loading="eager"'); // 2nd is also above-the-fold
    expect(matches[2]).toContain('loading="lazy"');
  });

  it('injects width/height from media lookup when missing', () => {
    const html = '<img src="https://cdn.example.com/x.png">';
    const out = transformBodyForSeo(
      html,
      buildMediaLookup([media({ width: 800, height: 600 })]),
    );
    expect(out).toContain('width="800"');
    expect(out).toContain('height="600"');
  });

  it('does NOT overwrite existing width/height/alt', () => {
    const html = '<img src="https://cdn.example.com/x.png" width="100" height="50" alt="hi">';
    const out = transformBodyForSeo(
      html,
      buildMediaLookup([media({ width: 800, height: 600, alt_text: 'auto-alt' })]),
    );
    expect(out).toContain('width="100"');
    expect(out).toContain('height="50"');
    expect(out).toContain('alt="hi"');
    expect(out).not.toContain('auto-alt');
  });

  it('is idempotent on the loading/decoding attributes', () => {
    const html = '<img src="/a.png">';
    const once = transformBodyForSeo(html, buildMediaLookup([]));
    const twice = transformBodyForSeo(once, buildMediaLookup([]));
    // Same number of attributes after a second pass.
    expect((twice.match(/loading=/g) ?? []).length).toBe(1);
    expect((twice.match(/decoding=/g) ?? []).length).toBe(1);
  });

  it('wraps CF-origin images in <picture> with srcset when CF origin is configured', () => {
    const html = '<img src="https://cdn.example.com/foo/bar.png">';
    const out = transformBodyForSeo(
      html,
      buildMediaLookup([]),
      { cfImageOrigin: 'https://cdn.example.com' },
    );
    expect(out).toContain('<picture>');
    expect(out).toContain('/cdn-cgi/image/width=400');
    expect(out).toContain('/cdn-cgi/image/width=1600');
    expect(out).toContain('format=auto');
  });

  it('leaves images on other origins alone', () => {
    const html = '<img src="https://other.example.com/x.png">';
    const out = transformBodyForSeo(
      html,
      buildMediaLookup([]),
      { cfImageOrigin: 'https://cdn.example.com' },
    );
    expect(out).not.toContain('<picture>');
    expect(out).not.toContain('/cdn-cgi/');
  });

  it('emits <picture> with AVIF + WebP sources from pre-generated R2 variants', () => {
    const html = '<img src="https://cdn.example.com/x.png">';
    const mediaWithVariants = media({
      width: 1920,
      height: 1080,
      variants: [
        { width: 320, format: 'webp', cdn_url: 'https://cdn.example.com/x.w320.webp', size_bytes: 12000 },
        { width: 640, format: 'webp', cdn_url: 'https://cdn.example.com/x.w640.webp', size_bytes: 30000 },
        { width: 1024, format: 'webp', cdn_url: 'https://cdn.example.com/x.w1024.webp', size_bytes: 60000 },
        { width: 320, format: 'avif', cdn_url: 'https://cdn.example.com/x.w320.avif', size_bytes: 8000 },
        { width: 640, format: 'avif', cdn_url: 'https://cdn.example.com/x.w640.avif', size_bytes: 22000 },
        { width: 1024, format: 'avif', cdn_url: 'https://cdn.example.com/x.w1024.avif', size_bytes: 42000 },
      ],
    });
    const out = transformBodyForSeo(html, buildMediaLookup([mediaWithVariants]));
    expect(out).toContain('<picture>');
    // AVIF source comes first (smallest, most efficient).
    const avifIdx = out.indexOf('type="image/avif"');
    const webpIdx = out.indexOf('type="image/webp"');
    expect(avifIdx).toBeGreaterThan(-1);
    expect(webpIdx).toBeGreaterThan(avifIdx);
    // Widths sorted ascending in srcset.
    expect(out).toContain('x.w320.avif 320w');
    expect(out).toContain('x.w640.avif 640w');
    expect(out).toContain('x.w1024.avif 1024w');
    // Width/height injected on the fallback <img> so layout is reserved
    // before any source loads → no CLS contribution.
    expect(out).toContain('width="1920"');
    expect(out).toContain('height="1080"');
  });

  it('R2 variants take precedence over Cloudflare Image Resizing when both apply', () => {
    const html = '<img src="https://cdn.example.com/x.png">';
    const out = transformBodyForSeo(
      html,
      buildMediaLookup([
        media({
          variants: [
            { width: 320, format: 'webp', cdn_url: 'https://cdn.example.com/x.w320.webp', size_bytes: 12000 },
            { width: 320, format: 'avif', cdn_url: 'https://cdn.example.com/x.w320.avif', size_bytes: 8000 },
          ],
        }),
      ]),
      { cfImageOrigin: 'https://cdn.example.com' },
    );
    // Should use the static variants, not /cdn-cgi/image/.
    expect(out).toContain('x.w320.avif');
    expect(out).not.toContain('/cdn-cgi/');
  });

  it('honors a per-image sizes attribute over the generic default (7a)', () => {
    const html = '<img src="https://cdn.example.com/x.png" sizes="(max-width: 640px) 360px, 560px">';
    const out = transformBodyForSeo(
      html,
      buildMediaLookup([media({
        variants: [
          { width: 320, format: 'webp', cdn_url: 'https://cdn.example.com/x.w320.webp', size_bytes: 12000 },
          { width: 320, format: 'avif', cdn_url: 'https://cdn.example.com/x.w320.avif', size_bytes: 8000 },
        ],
      })]),
    );
    // The author's sizes lands on the generated <source>s, not the generic one.
    expect(out).toContain('sizes="(max-width: 640px) 360px, 560px"');
    expect(out).not.toContain('100vw, 800px');
  });

  it('applies opts.defaultSizes when the <img> has no sizes (7a per-page/site default)', () => {
    const html = '<img src="https://cdn.example.com/x.png">';
    const out = transformBodyForSeo(
      html,
      buildMediaLookup([media({
        variants: [
          { width: 320, format: 'avif', cdn_url: 'https://cdn.example.com/x.w320.avif', size_bytes: 8000 },
        ],
      })]),
      { defaultSizes: '(max-width: 640px) 360px, 560px' },
    );
    expect(out).toContain('sizes="(max-width: 640px) 360px, 560px"');
    expect(out).not.toContain('100vw, 800px');
  });

  it('per-image sizes still wins over opts.defaultSizes (7a precedence)', () => {
    const html = '<img src="https://cdn.example.com/x.png" sizes="200px">';
    const out = transformBodyForSeo(
      html,
      buildMediaLookup([media({
        variants: [
          { width: 320, format: 'avif', cdn_url: 'https://cdn.example.com/x.w320.avif', size_bytes: 8000 },
        ],
      })]),
      { defaultSizes: '(max-width: 640px) 360px, 560px' },
    );
    expect(out).toContain('sizes="200px"');
    expect(out).not.toContain('360px, 560px');
  });

  it('falls back to the generic default when neither img sizes nor opts.defaultSizes is set', () => {
    const html = '<img src="https://cdn.example.com/x.png">';
    const out = transformBodyForSeo(
      html,
      buildMediaLookup([media({
        variants: [
          { width: 320, format: 'avif', cdn_url: 'https://cdn.example.com/x.w320.avif', size_bytes: 8000 },
        ],
      })]),
    );
    expect(out).toContain('sizes="(max-width: 768px) 100vw, 800px"');
  });

  it('does NOT re-wrap an <img> inside an author-written <picture> with long media-queried sources (7b)', () => {
    // The author pre-baked a <picture> to opt out of the generic sizes. The
    // opening <picture> tag sits >200 chars before the inner <img> because of
    // the long <source> list — the case that previously slipped the 200-char
    // idempotency window and produced invalid nested <picture> markup.
    const longSources =
      '<source media="(max-width: 639px)" srcset="https://cdn.example.com/x.w320.avif" type="image/avif" sizes="360px" />' +
      '<source media="(min-width: 640px)" srcset="https://cdn.example.com/x.w640.avif" type="image/avif" sizes="560px" />' +
      '<source media="(max-width: 639px)" srcset="https://cdn.example.com/x.w320.webp" type="image/webp" sizes="360px" />';
    const html = `<picture>${longSources}<img src="https://cdn.example.com/x.png" alt="hero"></picture>`;
    const out = transformBodyForSeo(
      html,
      // Media HAS variants — without the fix the transform would try to wrap.
      buildMediaLookup([media({
        variants: [
          { width: 320, format: 'avif', cdn_url: 'https://cdn.example.com/x.w320.avif', size_bytes: 8000 },
          { width: 640, format: 'avif', cdn_url: 'https://cdn.example.com/x.w640.avif', size_bytes: 22000 },
        ],
      })]),
    );
    // Exactly one <picture> opener — no nesting.
    expect((out.match(/<picture>/g) ?? []).length).toBe(1);
    // The author's custom sources are preserved verbatim.
    expect(out).toContain('media="(min-width: 640px)"');
    // loading/decoding defaults still get added to the inner <img>.
    expect(out).toContain('loading=');
  });

  it('skips <picture> wrap when media has no variants (single-image fallback)', () => {
    const html = '<img src="https://cdn.example.com/x.png">';
    const out = transformBodyForSeo(
      html,
      buildMediaLookup([media({ width: 800, height: 600 })]),
    );
    expect(out).not.toContain('<picture>');
    // But width/height still injected.
    expect(out).toContain('width="800"');
  });
});

describe('lintBodyForSeo', () => {
  it('flags images missing alt', () => {
    const warnings = lintBodyForSeo('<img src="/a.png"><img src="/b.png" alt="b">');
    expect(warnings.some((w) => /alt text/i.test(w))).toBe(true);
  });

  it('does NOT flag aria-hidden decorative images', () => {
    const warnings = lintBodyForSeo('<img src="/a.png" aria-hidden="true">');
    expect(warnings.some((w) => /alt text/i.test(w))).toBe(false);
  });

  it('flags missing <h1>', () => {
    expect(lintBodyForSeo('<p>no heading</p>').some((w) => /h1/i.test(w))).toBe(true);
  });

  it('flags multiple <h1>', () => {
    expect(lintBodyForSeo('<h1>a</h1><h1>b</h1>').some((w) => /2/.test(w))).toBe(true);
  });

  it('flags empty links', () => {
    expect(lintBodyForSeo('<a href="/x"></a>').some((w) => /no text content/i.test(w))).toBe(true);
  });
});
