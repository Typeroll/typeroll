import { describe, expect, it } from 'vitest';
import { buildCoreBlockRegistry, collectBlockAssets, fontFamilyCss, isSystemFont, renderBlock } from '../index.js';
const registry = buildCoreBlockRegistry();
const render = (type: string, data: Record<string, unknown>) => renderBlock({ id: 'example', type, data }, { registry });
describe('bounded native presentation', () => {
  it('serializes responsive numeric dimensions with units, preserving zero and limiting extreme values', () => {
    const html = render('core/heading', { text: 'Heading', font_size_px: { mobile: 24, desktop: 48 }, line_height: 1.2 });
    expect(html).toContain('--font_size_px:24px'); expect(html).toContain('--font_size_px: 48px');
    expect(html).toContain('--line_height:1.2');
    expect(render('core/container', { padding_x_px: 0 })).toContain('--padding_x_px:0px');
    expect(render('core/heading', { font_size_px: 9999 })).toContain('--font_size_px:160px');
    expect(render('core/heading', { font_size_px: '20px;color:red' })).not.toContain('color:red');
  });
  it('isolates exact dimensions on nested blocks rather than inheriting parent overrides', () => {
    const css = collectBlockAssets([{ id: 'c', type: 'core/container', data: {} }], registry).css;
    expect(css).toContain('--max_width_px:initial');
    expect(render('core/container', {})).toContain('data-presentation="core%2Fcontainer"');
  });
  it('gives an entire card one named link without nesting body links', () => {
    const html = render('core/icon_box', { heading: 'Packing', link: '/packing/', whole_card_link: true, text: '<a href="/help/">Help</a>', icon: '📦' });
    expect(html).toContain('<a href="/packing/">Packing</a>');
    expect(html.match(/href="\/packing\/"/g)).toHaveLength(1);
    expect(html).toContain('<a href="/help/">Help</a>');
    expect(html).not.toContain('Learn more');
    expect(render('core/icon_box', { whole_card_link: true, heading: 'No target' })).not.toContain('<a ');
  });
  it('attaches responsive attributes when the root includes a slash in a link', () => {
    const html = render('template/site_logo', { height_px: { mobile: 40, laptop: 50 } });
    expect(html).toMatch(/<a[^>]*href="\/"[^>]*data-bid="example"/);
    expect(html).toContain('data-presentation="template%2Fsite_logo"');
    expect(html).toContain('--height_px: 50px !important');
  });
  it('preserves inline editing and typed icon bindings on cards', () => {
    const block = { id: 'card', type: 'core/icon_box', data: { heading: 'Packing', link: '/packing/', whole_card_link: true, icon: '{{page.emoji}}' } };
    const html = renderBlock(block, { registry, editable: true, context: { page: { emoji: '📦' } } });
    expect(html).toContain('data-edit="card:heading"');
    expect(html).toContain('📦');
    expect(html).not.toContain('{{page.emoji}}');
  });
  it('uses the system font stack without treating it as a Google font', () => {
    expect(isSystemFont('system')).toBe(true); expect(isSystemFont('system-ui')).toBe(true);
    expect(fontFamilyCss('system')).toContain('-apple-system'); expect(fontFamilyCss('system')).not.toBe("'system'");
    expect(isSystemFont('Lato')).toBe(false); expect(fontFamilyCss('Lato')).toBe("'Lato'");
    expect(fontFamilyCss("x';}</style>")).not.toMatch(/[<>;{}]/);
  });
});
