import { describe, it, expect } from 'vitest';
import { buildCoreBlockRegistry, collectBlockAssets, renderBlock, unknownBlockDataFields } from '../index.js';
import type { Block } from '../types.js';

const registry = buildCoreBlockRegistry();
const links = [{ label: 'Features', href: '/features/' }, { label: 'Pricing', href: '/pricing/' }];
const block = (data: Record<string, unknown>): Block => ({ id: 'product', type: 'core/navigation_links', data: { links, direction: 'column', ...data } });

describe('navigation links group label', () => {
  it('titles the list with a visible label that names it, from render version 13', () => {
    const html = renderBlock(block({ group_label: 'Product <beta>' }), { registry, renderVersion: 13 });
    expect(html).toMatch(/^<div data-block="navigation_links" data-labelled="true"/);
    expect(html).toContain('<div class="block-nav-label tr-role-eyebrow" id="nav-label-product">Product &lt;beta&gt;</div>');
    expect(html).toContain('<ul class="block-nav-list" aria-labelledby="nav-label-product"><li><a href="/features/">Features</a></li>');
    // The label is not a heading: a menu repeated on every page stays out of the outline.
    expect(html).not.toMatch(/<h[1-6]/);
  });

  it('takes a chosen style instead of the Eyebrow role', () => {
    const html = renderBlock(block({ group_label: 'Product', group_label_style_id: 'menu-label' }), { registry, renderVersion: 13 });
    expect(html).toContain('class="block-nav-label s-menu-label"');
  });

  it('renders the bare list without a label, and on older render versions', () => {
    const bare = renderBlock(block({}), { registry, renderVersion: 12 });
    expect(bare).toMatch(/^<ul data-block="navigation_links"/);
    expect(renderBlock(block({}), { registry, renderVersion: 13 })).toBe(bare);
    expect(renderBlock(block({ group_label: '  ' }), { registry, renderVersion: 13 })).toBe(bare);
    expect(renderBlock(block({ group_label: 'Product' }), { registry, renderVersion: 12 })).toBe(renderBlock(block({}), { registry, renderVersion: 12 }));
  });

  it('accepts the label fields in block data', () => {
    expect(unknownBlockDataFields(block({ group_label: 'Product', group_label_style_id: 'menu-label' }), registry)).toEqual([]);
  });

  it('styles the label with theme tokens and keeps item rules for the wrapped list', () => {
    const css = collectBlockAssets([block({ group_label: 'Product' })], registry, { renderVersion: 13 }).css;
    const label = css.match(/\[data-block="navigation_links"\] > \.block-nav-label \{[^}]*\}/)![0];
    expect(label).toContain('color:var(--color-text-light,currentColor)');
    expect(label).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(/i);
    expect(css).toContain('[data-block="navigation_links"] li > a {');
    expect(css).not.toContain('] > li');
  });
});
