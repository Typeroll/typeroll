import { describe, it, expect } from 'vitest';
import { renderBlock } from '../render-blocks.js';
import { buildCoreBlockRegistry } from '../core-blocks.js';
import { prepareHeadingOutline } from '../heading-outline.js';
import type { Block } from '../types.js';

const registry = buildCoreBlockRegistry();
describe('post-card image links', () => {
  for (const surface of ['standalone', 'page_list', 'repeater']) for (const alt of ['', 'Boxes ready for shipping']) it(`${surface} names the image link with ${alt || 'decorative image'}`, () => {
    const item = { title: 'ABC Supplier', href: '/companies/abc/', url: '/companies/abc/', image: '/image.png', image_alt: alt };
    const block: Block = surface === 'standalone' ? { id: 'card', type: 'core/post_card', data: item }
      : surface === 'page_list' ? { id: 'cards', type: 'core/page_list', data: { content_type: 'supplier', item_overrides: { image_field: 'image', image_alt_field: 'image_alt' } } }
      : { id: 'cards', type: 'core/repeater', data: { source_type: 'static', item_block: 'core/post_card', items: [item] } };
    const html = renderBlock(block, { registry, pageSource: () => [item] });
    if (alt) expect(html).toContain(`alt="${alt}"`);
    else expect(html).toMatch(/<a[^>]*aria-label="ABC Supplier"[^>]*><img/);
    expect(html).not.toMatch(/<a\b[^>]*>\s*<a\b/);
  });
  it('supports mapped alt and a missing title fallback', () => {
    const html = renderBlock({ id: 'cards', type: 'core/page_list', data: { content_type: 'supplier', item_overrides: { image_field: 'image', image_alt_field: 'title' } } }, { registry, pageSource: () => [{ title: 'ABC', url: '/abc/', image: '/image.png' }] });
    expect(html).toContain('alt="ABC"');
    const missing = renderBlock({ id: 'card', type: 'core/post_card', data: { image: '/image.png', href: '/abc/' } }, { registry });
    expect(missing).toContain('aria-label="View page"');
    const unlinked = renderBlock({ id: 'card', type: 'core/post_card', data: { image: '/image.png', image_alt: '' } }, { registry });
    expect(unlinked).toContain('alt=""'); expect(unlinked).not.toMatch(/<a\b/);
  });
  it('gives a mobile navigation button a name even with hidden or empty visual text', () => {
    const html = renderBlock({ id: 'navigation', type: 'core/navigation', data: { menu_label: '', links: [] } }, { registry });
    expect(html).toContain('aria-label="Menu"');
  });
  it('source locators do not masquerade as heading anchors', () => {
    const result = prepareHeadingOutline('<h2 data-source-block-id="block123">Program details</h2>');
    expect(result.html).toContain('id="program-details"');
    expect(result.headings[0].id).toBe('program-details');
  });
});
