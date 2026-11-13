import { describe, expect, it } from 'vitest';
import { buildCoreBlockRegistry, buildMediaLookup, renderBlocks, transformBodyForSeo } from '../index.js';
import type { Media } from '../types.js';

const registry = buildCoreBlockRegistry();
const page = {
  title: 'Clean the oven',
  featured_image: 'https://media.example/oven.jpg',
  featured_image_alt: 'Illustration: a clean oven with the rack pulled out',
  mobile_image: 'https://media.example/oven-mobile.jpg',
};

function render(data: Record<string, unknown>, renderVersion = 16, context: Record<string, unknown> = { page }): string {
  return renderBlocks([{ id: 'fi', type: 'template/page_featured_image', data: { field: 'featured_image', ...data } }], {
    registry, renderVersion, context: context as never,
  });
}
const img = (html: string) => /<img\b[^>]*>/.exec(html)?.[0] ?? '';

describe('template/page_featured_image', () => {
  it('keeps its earlier markup when none of the newer settings is used', () => {
    expect(img(render({ width: 'full' }, 15))).toBe('<img src="https://media.example/oven.jpg" alt="Clean the oven" loading="lazy" decoding="async" />');
  });

  describe('alt text', () => {
    it('uses the named alt text field on every render version', () => {
      for (const version of [1, 16, 21]) {
        expect(img(render({ alt_field: 'featured_image_alt' }, version))).toContain('alt="Illustration: a clean oven with the rack pulled out"');
      }
    });

    it('falls back to the page title when the named field is empty', () => {
      expect(img(render({ alt_field: 'featured_image_alt' }, 16, { page: { ...page, featured_image_alt: '  ' } }))).toContain('alt="Clean the oven"');
    });

    it('reads <field>_alt by default from render version 21 only', () => {
      expect(img(render({}, 20))).toContain('alt="Clean the oven"');
      expect(img(render({}, 21))).toContain('alt="Illustration: a clean oven with the rack pulled out"');
      expect(img(render({}, 21, { page: { ...page, featured_image_alt: undefined } }))).toContain('alt="Clean the oven"');
    });

    it('escapes the alt text', () => {
      expect(img(render({ alt_field: 'featured_image_alt' }, 16, { page: { ...page, featured_image_alt: 'A "quoted" <oven>' } }))).toContain('alt="A &quot;quoted&quot; &lt;oven&gt;"');
    });
  });

  it('gives sizes that follow the width setting', () => {
    expect(img(render({ width: 'narrow' }))).toContain('sizes="(max-width: 512px) 100vw, 512px"');
    expect(img(render({ width: 'normal' }))).toContain('sizes="(max-width: 768px) 100vw, 768px"');
    expect(img(render({ width: 'wide' }))).toContain('sizes="(max-width: 1024px) 100vw, 1024px"');
    expect(img(render({ width: 'full' }))).not.toContain('sizes=');
  });

  it('loads eagerly with high priority when set to', () => {
    expect(img(render({ loading: 'eager' }))).toContain('loading="eager" fetchpriority="high"');
    expect(img(render({ loading: 'lazy' }))).toContain('loading="lazy"');
    expect(img(render({}))).toContain('loading="lazy"');
  });

  it('takes an aspect ratio per screen width', () => {
    const html = render({ width: 'full', fit: 'cover', aspect_ratio: { mobile: '16:9', laptop: '3:1' } });
    expect(html).toContain('data-aspect="16:9"');
    expect(img(html)).toContain('style="aspect-ratio:var(--featured-aspect,16/9)"');
    expect(html).toMatch(/@media \(min-width: 1024px\) \{ \[data-bid="fi"\]\[data-bid="fi"\] \{ --featured-aspect:3\/1; \} \}/);
    // A single ratio keeps the block's CSS rule, except 21:9, which has none.
    expect(img(render({ aspect_ratio: '16:9' }))).not.toContain('style=');
    expect(img(render({ aspect_ratio: '21:9' }))).toContain('style="aspect-ratio:var(--featured-aspect,21/9)"');
  });

  it('caps the height, per screen width', () => {
    expect(img(render({ max_height_px: 300 }))).toContain('style="max-height:calc(var(--max_height_px,300) * 1px)"');
    const html = render({ max_height_px: { mobile: 600, laptop: 300 } });
    expect(img(html)).toContain('max-height:calc(var(--max_height_px,600) * 1px)');
    expect(html).toMatch(/@media \(min-width: 1024px\) \{ \[data-bid="fi"\] \{ --max_height_px: 300; \} \}/);
    expect(img(render({ max_height_px: 5 }))).toContain('var(--max_height_px,80)');
  });

  it('shows a mobile image from another page field', () => {
    const html = render({ mobile_field: 'mobile_image', mobile_src_below: 'tablet' });
    expect(html).toContain('<picture data-tr-art-direction><source media="(width < 640px)" srcset="https://media.example/oven-mobile.jpg" /><img ');
    expect(html).toContain('</picture>');
    expect(render({ mobile_field: 'missing_field' })).not.toContain('<picture');
  });

  it('publishes as a <picture> with AVIF and WebP, eager as the first image', () => {
    const media = [{
      id: 'm', cdn_url: page.featured_image, width: 1600, height: 900,
      variants: ['avif', 'webp'].flatMap(format => [640, 1280].map(width => ({ format, width, cdn_url: `https://media.example/oven-${width}.${format}` }))),
    }] as unknown as Media[];
    const html = transformBodyForSeo(render({ width: 'narrow', aspect_ratio: '16:9', fit: 'cover', alt_field: 'featured_image_alt' }), buildMediaLookup(media), { defaultSizes: '(max-width: 1023px) 100vw, 75vw' });
    expect(html).toContain('<source type="image/avif" srcset="https://media.example/oven-640.avif 640w, https://media.example/oven-1280.avif 1280w" sizes="(max-width: 512px) 100vw, 512px" />');
    expect(html).toContain('<source type="image/webp"');
    expect(img(html)).toContain('loading="eager"');
    expect(img(html)).toContain('fetchpriority="high"');
    expect(img(html)).toContain('alt="Illustration: a clean oven with the rack pulled out"');
  });
});
