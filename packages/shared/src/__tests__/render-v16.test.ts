import { describe, expect, it } from 'vitest';
import { buildCoreBlockRegistry } from '../core-blocks.js';
import { collectBlockAssets, renderBlocks } from '../render-blocks.js';
import { directionCss } from '../rtl-css.js';
import { renderCookieConsent } from '../cookie-consent.js';
import { dataAttributeFields, mapMediaBreakpoints, rewriteSettingSelectors, takeInlineCustomProperties } from '../render-v16.js';

const registry = buildCoreBlockRegistry();
const render = (blocks: Parameters<typeof renderBlocks>[0], renderVersion: number) => renderBlocks(blocks, { registry, renderVersion });

describe('render version 16: settings site CSS can change', () => {
  it('rewrites style-text selectors for select and number settings to data attributes', () => {
    const schema = [
      { name: 'gap', type: 'select', label: 'Gap', options: ['sm', 'lg'] },
      { name: 'gap_px', type: 'number', label: 'Gap', css_unit: 'px' },
      { name: 'background', type: 'color', label: 'Background' },
    ] as const;
    const css = '[data-block="grid"][style*="--gap:sm"] { a:b } [data-block="grid"][style*="--gap_px:"] { c:d } [data-block="x"][style*="--background:;"] { e:f }';
    expect(rewriteSettingSelectors(css, schema as never)).toBe('[data-block="grid"][data-gap="sm"] { a:b } [data-block="grid"][data-gap-px] { c:d } [data-block="x"][style*="--background:;"] { e:f }');
  });

  it('matches a data attribute by its whole name, not a longer one that starts with it', () => {
    const type = { schema: [{ name: 'height', type: 'select', label: 'H', options: ['sm'] }, { name: 'height_px', type: 'number', label: 'H', css_unit: 'px' }] } as never;
    expect(dataAttributeFields(type, '[data-block="x"][data-height-px] { a:b }')).toEqual(['height_px']);
    expect(dataAttributeFields(type, '[data-block="x"][data-height="sm"] { a:b }')).toEqual(['height']);
  });

  it('emits the attributes the CSS reads, and nothing below 16', () => {
    const grid = { id: 'g1', type: 'core/grid', data: { gap: 'lg' } };
    expect(render([grid], 16)).toContain('data-gap="lg"');
    expect(render([grid], 15)).not.toContain('data-gap=');
    const css = collectBlockAssets([grid], registry, { renderVersion: 16 }).css;
    expect(css).toContain('[data-block="grid"][data-gap="lg"]');
    expect(css).not.toContain('[style*="--gap:lg"]');
    expect(collectBlockAssets([grid], registry, { renderVersion: 15 }).css).toContain('[style*="--gap:lg"]');
  });

  it('maps media query literals to the site breakpoints, except widths an author chose', () => {
    expect(mapMediaBreakpoints('@media (max-width: 720px) { a { b:c } }')).toBe('@media (max-width: 639px) { a { b:c } }');
    expect(mapMediaBreakpoints('@media (min-width: 769px) { a { b:c } }')).toBe('@media (min-width: 640px) { a { b:c } }');
    expect(mapMediaBreakpoints('@media (max-width: 1023px) { a { b:c } }', { mobile: 0, tablet: 600, laptop: 900, desktop: 1200, wide: 1500 })).toBe('@media (max-width: 899px) { a { b:c } }');
    const chosen = '@media (max-width:767px) { [data-block="columns"][data-stack-below="768"] { x:y } }';
    expect(mapMediaBreakpoints(chosen)).toBe(chosen);
    const menu = '@media(max-width:767px) { [data-block="navigation_menu"][data-collapse="768"] > a { x:y } }';
    expect(mapMediaBreakpoints(menu)).toBe(menu);
  });

  it('writes authored spacing and image widths as custom properties applied from the instance layer', () => {
    const spaced = { id: 'p1', type: 'core/prose', data: { content: '<p>Hi</p>' }, style_overrides: { spacing_before: '2rem', spacing_after: '1rem' } };
    const v16 = render([spaced], 16);
    expect(v16).toContain('--space-before:2rem');
    expect(v16).toContain('data-space-before');
    expect(v16).not.toContain('margin-top:2rem');
    expect(render([spaced], 15)).toContain('margin-top:2rem');
    const image = { id: 'i1', type: 'core/image', data: { src: '/a.jpg', alt: 'A', max_width: 400 } };
    expect(render([image], 16)).toContain('--image-max:min(100%,400px)');
    expect(render([image], 16)).toContain('data-max-width');
    expect(render([image], 15)).toContain('max-width:min(100%,400px)');
    const css = collectBlockAssets([spaced, image], registry, { renderVersion: 16 }).css;
    expect(css).toMatch(/@layer typeroll\.instance\{\n\[data-space-before\] \{ margin-top:var\(--space-before\); \}/);
    expect(collectBlockAssets([spaced], registry, { renderVersion: 15 }).css).not.toContain('data-space-before');
  });

  it('sets responsive mobile values from the instance layer, so breakpoint overrides need no !important', () => {
    const grid = { id: 'g2', type: 'core/grid', data: { cols: { mobile: 1, laptop: 3 } } };
    const v16 = render([grid], 16);
    expect(v16).not.toMatch(/style="[^"]*--cols:1/);
    expect(v16).toContain('@layer typeroll.instance{');
    expect(v16).toContain('[data-bid="g2"] { --cols: 1; }');
    expect(v16).toContain('--cols: 3;');
    expect(v16).not.toContain('!important');
    const v15 = render([grid], 15);
    expect(v15).toContain('--cols: 3 !important;');
  });

  it('keeps the other inline declarations when it takes custom properties out', () => {
    const taken = takeInlineCustomProperties('<div data-block="x" style="--cols:2;--gap:md;color:red"><i style="--cols:9"></i></div>', ['cols']);
    expect(taken.values).toEqual({ cols: '2' });
    expect(taken.html).toBe('<div data-block="x" style="--gap:md;color:red"><i style="--cols:9"></i></div>');
    expect(takeInlineCustomProperties('<div style="--cols:2">', ['cols']).html).toBe('<div>');
  });

  it('layers the column stacking width, visibility and the right-to-left mirror', () => {
    const columns = { id: 'c1', type: 'core/columns', data: { stack_below_px: 900 }, slots: [[], []] };
    expect(render([columns], 16)).toContain('@layer typeroll.instance{');
    expect(render([columns], 16)).not.toContain('!important');
    expect(render([columns], 15)).toContain('!important');
    const hidden = { id: 'h1', type: 'core/prose', data: { content: '<p>x</p>' }, hidden_on: ['mobile' as const] };
    const site = { responsive_breakpoints: { tablet: 600, laptop: 900, desktop: 1200, wide: 1500 } };
    const visibility = renderBlocks([hidden], { registry, renderVersion: 16, context: { site } });
    expect(visibility).toContain('@layer typeroll.instance{');
    expect(visibility).toContain('display:none !important');
    expect(directionCss('rtl', 16)).toMatch(/^@layer typeroll\.platform\{/);
    expect(directionCss('rtl', 15)).not.toContain('@layer');
    const consent = { enabled: true } as never;
    expect(renderCookieConsent(consent, undefined, 'en', { renderVersion: 16 })).toContain('@layer typeroll.base{');
    expect(renderCookieConsent(consent, undefined, 'en')).not.toContain('@layer');
  });

  it('ships heading and text CSS for the site title, excerpt and tagline from 16', () => {
    const title = { id: 't1', type: 'template/site_title', data: {} };
    expect(collectBlockAssets([title], registry, { renderVersion: 16 }).used_ids).toContain('core/heading');
    expect(collectBlockAssets([title], registry, { renderVersion: 15 }).used_ids).not.toContain('core/heading');
    const tagline = { id: 't2', type: 'template/site_tagline', data: {} };
    expect(collectBlockAssets([tagline], registry, { renderVersion: 16 }).used_ids).toContain('core/prose');
  });
});
