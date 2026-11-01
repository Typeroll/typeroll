import { describe, expect, it } from 'vitest';
import { cssRules, lintSiteCss, loadedFontFamilies, primaryFontFamily, IMPORTANT_THRESHOLD } from '../site-css-lint.js';
import type { Block } from '../types.js';

const fonts = { heading: 'Georgia', body: 'Inter', size_base: 16 };

describe('custom CSS lint', () => {
  it('flattens rules inside media queries', () => {
    expect(cssRules('a{color:red}@media (min-width:1px){.x{gap:1px}}').map(rule => rule.selector)).toEqual(['a', '.x']);
  });

  it('reads the primary family from font-family and the font shorthand', () => {
    expect(primaryFontFamily('font-family', "'Fraunces', Georgia, serif")).toBe('Fraunces');
    expect(primaryFontFamily('font', '600 .69rem/1.5 Inter,system-ui,sans-serif!important')).toBe('Inter');
    expect(primaryFontFamily('font-family', 'var(--font-body)')).toBeNull();
    expect(primaryFontFamily('font-family', 'system-ui, sans-serif')).toBeNull();
  });

  it('finds fonts loaded by @font-face and Google Fonts links', () => {
    expect(loadedFontFamilies("@font-face{font-family:'Fraunces';src:url(x.woff2)}")).toEqual(['Fraunces']);
    expect(loadedFontFamilies('<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600&amp;family=Space+Grotesk&display=swap">')).toEqual(['Inter', 'Space Grotesk']);
  });

  it('reports heavy !important use, foreign fonts, block-class rules and duplicate theme font loads', () => {
    const custom_css = [
      Array.from({ length: IMPORTANT_THRESHOLD }, (_, i) => `.tr-${i}{margin:0!important}`).join(''),
      "h1,h2{font-family:'Fraunces',Georgia,serif!important}",
      'body{font-family:Inter,system-ui,sans-serif}',
      '.block-button-link{border-radius:5px}',
      "@font-face{font-family:'Inter';src:url(/inter.woff2)}",
    ].join('\n');
    const codes = lintSiteCss({ fonts, custom_css }, []).map(finding => [finding.code, finding.value ?? finding.count]);
    expect(codes).toContainEqual(['css_important_overuse', IMPORTANT_THRESHOLD + 1]);
    expect(codes).toContainEqual(['css_font_not_in_theme', 'fraunces']);
    expect(codes).not.toContainEqual(['css_font_not_in_theme', 'inter']);
    expect(codes).toContainEqual(['css_block_class_override', 1]);
    expect(codes).toContainEqual(['css_duplicate_font_load', 'Inter']);
  });

  it('flags a theme font loaded again from scripts_head', () => {
    const findings = lintSiteCss({ fonts, scripts_head: '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter">' }, []);
    expect(findings).toEqual([expect.objectContaining({ code: 'css_duplicate_font_load', path: 'scripts_head', value: 'Inter' })]);
  });

  it('finds a first-section background image set in custom CSS through its class', () => {
    const blocks: Block[] = [{ id: 'hero', type: 'core/section', data: { css_class: 'tr-section tr-hero' } }, { id: 'next', type: 'core/section', data: {} }];
    const findings = lintSiteCss({ fonts, custom_css: '.tr-hero{background-image:url(/hero.webp)!important;background-size:cover}' }, [{ kind: 'page', id: 'home', blocks }]);
    expect(findings).toContainEqual(expect.objectContaining({ code: 'css_first_section_background_image', source: 'page:home', path: 'settings.custom_css' }));
  });

  it('accepts CSS that extends the theme', () => {
    const blocks: Block[] = [{ id: 'hero', type: 'core/section', data: { background_image: '/hero.webp' } }];
    expect(lintSiteCss({ fonts, custom_css: '.note{color:var(--color-text);font-family:var(--font-body)}' }, [{ kind: 'page', id: 'home', blocks }])).toEqual([]);
  });
});
