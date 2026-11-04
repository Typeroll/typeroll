// Images get a `sizes` that matches the width their layout renders them at,
// so cards in a grid and images in a column load a fitting variant instead of
// the generic 800px default.
import { describe, expect, it } from 'vitest';
import { buildCoreBlockRegistry } from '../core-blocks';
import { columnSlotSizes, gridItemSizes, renderBlocks, repeaterItemSizes, withImageSizes } from '../render-blocks';

const registry = buildCoreBlockRegistry();
const sizesOf = (html: string) => [...html.matchAll(/<img\b[^>]*\ssizes="([^"]*)"/g)].map(match => match[1]!.replace(/^auto, /, ''));

describe('layout-aware image sizes', () => {
  it('sizes repeater items by their columns', () => {
    expect(repeaterItemSizes({ layout: 'grid', cols: 3 })).toBe('(max-width: 767px) 100vw, 34vw');
    expect(repeaterItemSizes({ layout: 'grid', cols: 4, mobile_cols: 2 })).toBe('(max-width: 767px) 50vw, 25vw');
    expect(repeaterItemSizes({ layout: 'list', cols: 3 })).toBeNull();
    const html = renderBlocks([{ id: 'r', type: 'core/repeater', data: {
      item_block: 'core/image', layout: 'grid', cols: 3, items: [{ src: 'https://media.example.com/a.jpg', alt: 'A' }],
    } }], { registry });
    expect(sizesOf(html)).toEqual(['(max-width: 767px) 100vw, 34vw']);
  });

  it('sizes the cells of a core/grid by its columns until it stacks', () => {
    expect(gridItemSizes({ cols: 3 })).toBe('(max-width: 720px) 100vw, 34vw');
    expect(gridItemSizes({ cols: 4, stack_at: 'md' })).toBe('(max-width: 900px) 100vw, 25vw');
    expect(gridItemSizes({ cols: 1 })).toBeNull();
    const html = renderBlocks([{ id: 'g', type: 'core/grid', data: { cols: 3 }, children: [
      { id: 'i', type: 'core/image', data: { src: 'https://media.example.com/a.jpg', alt: 'A' } },
    ] }], { registry });
    expect(sizesOf(html)).toEqual(['(max-width: 720px) 100vw, 34vw']);
  });

  it('sizes each side of two columns by its share until they stack', () => {
    expect(columnSlotSizes({ ratio: '2-1' }, 0)).toBe('(max-width: 720px) 100vw, 67vw');
    expect(columnSlotSizes({ ratio: '2-1', stack_below: '1024' }, 1)).toBe('(max-width: 1023px) 100vw, 34vw');
    expect(columnSlotSizes({ left_width_px: 280 }, 0)).toBe('(max-width: 720px) 100vw, 280px');
    const html = renderBlocks([{ id: 'c', type: 'core/columns', data: { ratio: '1-1' }, slots: [
      [{ id: 'i', type: 'core/image', data: { src: 'https://media.example.com/a.jpg', alt: 'A' } }], [],
    ] }], { registry });
    expect(sizesOf(html)).toEqual(['(max-width: 720px) 100vw, 50vw']);
  });

  it('keeps a sizes the inner markup already set', () => {
    expect(withImageSizes('<img sizes="64px" src="a"><img src="b">', '50vw')).toBe('<img sizes="64px" src="a"><img sizes="50vw" src="b">');
    const capped = renderBlocks([{ id: 'i', type: 'core/image', data: { src: 'https://media.example.com/a.jpg', alt: 'A', max_width: 300 } }], { registry });
    expect(sizesOf(capped)).toEqual(['(max-width: 300px) 100vw, 300px']);
  });
});

describe('block-agnostic sizes', () => {
  it('sizes images in a custom block type that declares a cols field', () => {
    const custom = new Map(registry);
    custom.set('acme/card_row', { id: 'acme/card_row', name: 'card_row', label: 'Card row', category: 'layout', container: true,
      schema: [{ name: 'cols', type: 'number', label: 'Columns' }], template: '<div class="acme-row">{{children}}</div>' } as never);
    custom.set('acme/plain', { id: 'acme/plain', name: 'plain', label: 'Plain', category: 'layout', container: true,
      schema: [{ name: 'title', type: 'text', label: 'Title' }], template: '<div>{{children}}</div>' } as never);
    const image = { id: 'i', type: 'core/image', data: { src: 'https://media.example.com/a.jpg', alt: 'A' } };
    expect(sizesOf(renderBlocks([{ id: 'r', type: 'acme/card_row', data: { cols: 4 }, children: [image] }], { registry: custom })))
      .toEqual(['(max-width: 720px) 100vw, 25vw']);
    expect(sizesOf(renderBlocks([{ id: 'p', type: 'acme/plain', data: { title: 'x' }, children: [image] }], { registry: custom }))).toEqual([]);
  });

  it('lets lazy images use their rendered width and keeps eager ones on the fallback', async () => {
    const { buildMediaLookup, transformBodyForSeo } = await import('../seo-transform');
    const variants = [320, 1024].flatMap(width => (['avif', 'webp'] as const).map(format => ({ width, format, cdn_url: `https://m.example/a.png.w${width}.${format}` })));
    const lookup = buildMediaLookup([{ id: 'a', cdn_url: 'https://m.example/a.png', width: 1200, height: 800, variants }] as never);
    const out = transformBodyForSeo('<img src="https://m.example/a.png" alt="" /><p>x</p><img src="https://m.example/a.png" alt="" sizes="auto, 34vw" />', lookup);
    const [first, second] = out.split('<p>x</p>');
    expect(first).not.toContain('auto');
    expect(first).toContain('sizes="(max-width: 768px) 100vw, 800px"');
    expect(second).toMatch(/<source type="image\/avif" srcset="[^"]+" sizes="auto, 34vw" \/>/);
    expect(second).toContain('loading="lazy"');
    // Never on the <img> itself: browsers would give it a 300×150 placeholder size.
    expect(second).toMatch(/<img [^>]*sizes="34vw"/);
  });
});

describe('header and footer images', () => {
  it('get variants without taking the leading slot or a lazy default', async () => {
    const { buildMediaLookup, transformBodyForSeo } = await import('../seo-transform');
    const variants = [320].flatMap(width => (['avif', 'webp'] as const).map(format => ({ width, format, cdn_url: `https://m.example/h.png.w${width}.${format}` })));
    const lookup = buildMediaLookup([{ id: 'h', cdn_url: 'https://m.example/h.png', width: 600, height: 200, variants }] as never);
    const out = transformBodyForSeo('<img src="https://m.example/h.png" alt="Banner" />', lookup, { leadingImage: false });
    expect(out).toContain('<picture><source type="image/avif"');
    expect(out).toContain('width="600"');
    expect(out).not.toContain('fetchpriority');
    expect(out).not.toContain('loading=');
  });
});

describe('auto sizes need known dimensions', () => {
  it('keeps the plain fallback on sources of a lazy image without width and height', async () => {
    const { buildMediaLookup, transformBodyForSeo } = await import('../seo-transform');
    const variants = [320].flatMap(width => (['avif', 'webp'] as const).map(format => ({ width, format, cdn_url: `https://m.example/s.png.w${width}.${format}` })));
    const lookup = buildMediaLookup([{ id: 's', cdn_url: 'https://m.example/s.png', variants }] as never);
    const out = transformBodyForSeo('<img src="https://m.example/x.png" alt="" /><img src="https://m.example/s.png" alt="" sizes="50vw" />', lookup);
    expect(out).not.toContain('auto');
  });
});

