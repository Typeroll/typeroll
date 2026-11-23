import { describe, expect, it } from 'vitest';
import { footerSpacingError, footerSpacingCss, footerSpacingWarnings, blockFooterSpace } from '../footer-spacing.js';
import { buildCoreBlockRegistry } from '../core-blocks.js';
import { renderBlocks } from '../render-blocks.js';
import type { Block } from '../types.js';
const ending = (padding: unknown = 0): Block => ({ id: 'end', type: 'core/container', data: { padding_bottom_px: padding }, children: [{ id: 'text', type: 'core/prose', data: { html: '<p>Final paragraph</p>' } }] });
describe('shared footer spacing', () => {
  it('provides an independent responsive minimum even for block-owned zero padding', () => {
    const css = footerSpacingCss({ footer_min_spacing: { mobile: 32, laptop: 64 } }, {});
    expect(css).toContain('.page-content--blocks{padding-block-end:32px}');
    expect(css).toContain('.page-content--blocks{padding-block-end:64px}');
    expect(footerSpacingCss({ footer_min_spacing: 64 }, { footer_spacing: 'none' })).not.toContain('64px');
    expect(footerSpacingWarnings([ending(0)], {}, [], 64)).toEqual([]);
  });
  it('validates responsive tokens and bounded px without accepting arbitrary CSS', () => {
    for (const value of ['xl', 0, 72, { mobile: 'lg', desktop: 'xl' }]) expect(footerSpacingError(value)).toBeNull();
    for (const value of ['48px', -1, 321, {}, { phone: 'xl' }, { mobile: 'wrong' }, '0;display:none']) expect(footerSpacingError(value)).toBeTruthy();
  });
  it('preserves unconfigured sites and respects an explicit opt-out', () => {
    expect(footerSpacingCss({}, {})).toBe('');
    expect(footerSpacingCss({ footer_spacing: 'xl' }, { footer_spacing: 'none' })).not.toContain('var(--space-xl)');
  });
  it('uses site breakpoints and responsive named scales', () => {
    const css = footerSpacingCss({ footer_spacing: { mobile: 'lg', desktop: 80 }, responsive_breakpoints: { tablet: 700, laptop: 1000, desktop: 1400, wide: 1600 } }, {});
    expect(css).toContain('min-width:700px');
    expect(css).toContain('var(--space-lg)');
    expect(css).toContain('min-width:1400px');
    expect(css).toContain('padding-block-end:80px');
  });
  it('distinguishes missing padding, explicit zero, and responsive overrides', () => {
    expect(blockFooterSpace({ ...ending(), data: {} }, 'mobile').own).toBe(false);
    expect(blockFooterSpace(ending({ mobile: 0, laptop: 48 }), 'mobile').zero).toBe(true);
    expect(blockFooterSpace(ending({ mobile: 0, laptop: 48 }), 'desktop').zero).toBe(false);
  });
  it('warns on the affected widths and suppresses intentional or padded endings', () => {
    const warnings = footerSpacingWarnings([ending({ mobile: 0, laptop: 48 })], {});
    expect(warnings).toMatchObject([{ code: 'footer_spacing_zero', block_id: 'end', breakpoints: ['mobile', 'tablet'] }]);
    expect(footerSpacingWarnings([ending()], { footer_spacing: 'none' })).toEqual([]);
    expect(footerSpacingWarnings([ending(32)], {})).toEqual([]);
    const nested = ending(); nested.children![0] = { ...ending(24), id: 'inner' };
    expect(footerSpacingWarnings([nested], {})).toEqual([]);
  });
  it('recognizes a form and selected styles instead of warning on all zero containers', () => {
    const form = ending(); form.children = [{ id: 'form', type: 'core/form', data: { form_id: 'quote' } }];
    expect(footerSpacingWarnings([form], {})).toHaveLength(1);
    form.children = [{ id: 'image', type: 'core/image', data: { src: '/photo.jpg' } }];
    expect(footerSpacingWarnings([form], {})).toEqual([]);
    expect(blockFooterSpace({ ...ending(), data: { style_id: 'spaced' } }, 'desktop', [{ id: 'spaced', name: 'Spaced', targets: ['container'], base: { padding: 'lg md' } }])).toEqual({ own: true, zero: false });
  });
  it('only marks rendered blocks when enabled and applies route overrides', () => {
    const block = ending(); block.hidden_on = ['tablet'];
    const registry = buildCoreBlockRegistry();
    expect(renderBlocks([block], { registry })).not.toContain('data-footer-');
    const html = renderBlocks([block], { registry, context: { site: { footer_spacing: 'xl' } } });
    expect(html).toContain('data-footer-own-mobile');
    expect(html).toContain('data-footer-hidden-tablet');
    block.data = {};
    block.route_overrides = { home: { data_overrides: { padding_bottom_px: 0 } } };
    expect(renderBlocks([block], { registry, context: { route: 'home', site: { footer_spacing: 'xl' } } })).toContain('data-footer-own-mobile');
    expect(renderBlocks([block], { registry, context: { route: 'page', site: { footer_spacing: 'xl' } } })).not.toContain('data-footer-own-mobile');
  });
});
