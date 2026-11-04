// Images get a `sizes` that matches the width their layout renders them at,
// so cards in a grid and images in a column load a fitting variant instead of
// the generic 800px default.
import { describe, expect, it } from 'vitest';
import { buildCoreBlockRegistry } from '../core-blocks';
import { columnSlotSizes, gridItemSizes, renderBlocks, repeaterItemSizes, withImageSizes } from '../render-blocks';

const registry = buildCoreBlockRegistry();
const sizesOf = (html: string) => [...html.matchAll(/<img\b[^>]*\ssizes="([^"]*)"/g)].map(match => match[1]);

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
