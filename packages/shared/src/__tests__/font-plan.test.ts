import { describe, expect, it } from 'vitest';
import {
  buildCoreBlockRegistry, collectFontUsage, fontFallbackFacesCss, fontRoleFamilies, fontSampleText, fontServiceProvider,
  fontServiceStylesheet, googleFontsCssUrl, matchFontWeight, planSiteFonts, searchFontCatalog, serviceStylesheetFamilies,
  siteFontsErrors, siteThemeCss, defaultSiteSettings, webFontFamilies, webfontFallbackCss, validateSiteStyle, siteStylesCss, resolveBreakpointWidths,
  type FontPlan, type FontUsage, type SiteStyle, type Block,
} from '../index.js';

const registry = buildCoreBlockRegistry();
const none = { weights: [], italic: [] };
const usage = (partial: Partial<FontUsage>): FontUsage => ({ heading: none, body: { weights: [400], italic: [] }, mono: none, display: none, accent: none, ...partial });

describe('collectFontUsage', () => {
  it('needs body 400 and bold headings for a site without styles or blocks', () => {
    expect(collectFontUsage({})).toEqual(usage({ heading: { weights: [700], italic: [] } }));
  });

  it('reads styles, block weights, block defaults and rich text', () => {
    const styles = [
      ...['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].map(role => ({ id: role, name: role, role, targets: [], base: { weight: role === 'h1' ? 800 : 600 } })),
      { id: 'eyebrow', name: 'Eyebrow', role: 'eyebrow', targets: ['text'], base: { font: 'accent', weight: 500, italic: true }, at: { desktop: { weight: 600 } } },
    ] as SiteStyle[];
    const blocks: Block[] = [
      { id: 'a', type: 'core/prose', data: { html: '<p>Hello <strong>bold</strong> and <em>italic</em></p>', font_weight: { mobile: '500', desktop: 'inherit' } } },
      { id: 'b', type: 'core/rich_heading', data: { html: 'Title' } },
      { id: 'c', type: 'core/container', data: {}, children: [{ id: 'd', type: 'core/prose', data: { font: 'display', html: '<p>x</p>' }, responsive: { desktop: { data_overrides: { font_weight: '300' } } } }] },
    ];
    const result = collectFontUsage({ styles, blocks, blockTypes: registry });
    // Every heading element has a weight, so 700 is not added for them; rich_heading defaults to 600.
    expect(result.heading.weights).toEqual([600, 800]);
    expect(result.body).toEqual({ weights: [400, 500, 700], italic: [400, 700] });
    expect(result.accent).toEqual({ weights: [500, 600], italic: [500, 600] });
    expect(result.display.weights).toEqual([300]);
  });

  it('counts headings inside rich text and blocks in slots', () => {
    const blocks: Block[] = [{ id: 'cols', type: 'core/columns', data: {}, slots: [[{ id: 'p', type: 'core/prose', data: { html: '<h3>Sub</h3>' } }]] }];
    expect(collectFontUsage({ blocks, styles: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].map(role => ({ id: role, name: role, role, targets: [], base: { weight: 500 } })) as SiteStyle[] }).heading.weights).toEqual([500, 700]);
  });
});

describe('matchFontWeight', () => {
  it('follows CSS font matching', () => {
    expect(matchFontWeight(600, [400, 700])).toBe(700);
    expect(matchFontWeight(500, [400, 700])).toBe(400);
    expect(matchFontWeight(400, [300, 500, 700])).toBe(500);
    expect(matchFontWeight(300, [400, 700])).toBe(400);
    expect(matchFontWeight(800, [400, 700])).toBe(700);
    expect(matchFontWeight(200, [100, 400])).toBe(100);
    expect(matchFontWeight(400, [])).toBeUndefined();
  });
});

describe('planSiteFonts', () => {
  it('keeps the fixed 400–700 request before render version 15', () => {
    const fonts = { heading: 'Playfair Display', body: 'Inter', mono: 'JetBrains Mono', display: 'Lato' };
    const plan = planSiteFonts(fonts, usage({}), { renderVersion: 14 });
    expect(plan.google_css_url).toBe(googleFontsCssUrl(webFontFamilies('Playfair Display', 'Inter', 'JetBrains Mono')));
    expect(plan.families.map(family => family.family)).toEqual(['Playfair Display', 'Inter', 'JetBrains Mono']);
  });

  it('loads a variable family as one range and a static family by weight', () => {
    const plan = planSiteFonts({ heading: 'Lato', body: 'Inter' }, usage({ heading: { weights: [600, 800], italic: [] }, body: { weights: [400, 700], italic: [400] } }), { renderVersion: 15 });
    expect(plan.families).toEqual([
      { family: 'Lato', roles: ['heading', 'display'], source: 'google', category: 'sans', weights: [700, 900], italic: [] },
      { family: 'Inter', roles: ['body', 'accent'], source: 'google', category: 'sans', weights: [400, 700], italic: [400], variable: { weights: [400, 700] } },
    ]);
    expect(plan.google_css_url).toBe('https://fonts.googleapis.com/css2?family=Lato:wght@700;900&family=Inter:ital,wght@0,400..700;1,400&display=swap');
  });

  it('gives display and accent their own family when set, with the usage of their role', () => {
    const plan = planSiteFonts({ heading: 'Inter', body: 'Inter', display: 'Playfair Display', accent: 'inter' }, usage({ heading: { weights: [700], italic: [] }, display: { weights: [900], italic: [900] } }), { renderVersion: 15 });
    expect(plan.families.map(family => [family.family, family.roles, family.weights, family.italic])).toEqual([
      ['Inter', ['heading', 'body', 'accent'], [400, 700], []],
      ['Playfair Display', ['display'], [900], [900]],
    ]);
  });

  it('adds weights to load and normalises catalog names', () => {
    const plan = planSiteFonts({ heading: 'roboto', body: 'roboto', load: { body: { weights: [300] } } }, usage({}), { renderVersion: 15 });
    expect(plan.families[0]).toMatchObject({ family: 'Roboto', weights: [300, 400], variable: { weights: [300, 400] } });
  });

  it('keeps the legacy request for a family outside the catalog', () => {
    const plan = planSiteFonts({ heading: 'Some Brand Sans', body: 'system' }, usage({ heading: { weights: [700], italic: [] } }), { renderVersion: 15 });
    expect(plan.google_css_url).toBe('https://fonts.googleapis.com/css2?family=Some%20Brand%20Sans:wght@400;500;600;700&display=swap');
  });

  it('publishes the library files covering the weights in use', () => {
    const library = [
      { id: 'r', family: 'Brand', weight: 400, style: 'normal' as const },
      { id: 'b', family: 'Brand', weight: 700, style: 'normal' as const },
      { id: 'k', family: 'Brand', weight: 900, style: 'normal' as const },
      { id: 'i', family: 'Brand', weight: 400, style: 'italic' as const },
      { id: 'v', family: 'Brand Variable', weight: [100, 900] as [number, number], style: 'normal' as const, category: 'serif' as const },
    ];
    const plan = planSiteFonts({ heading: 'Brand Variable', body: 'Brand' }, usage({ heading: { weights: [600, 800], italic: [] }, body: { weights: [400, 600], italic: [] } }), { renderVersion: 15, library });
    expect(plan.families).toEqual([
      { family: 'Brand Variable', roles: ['heading', 'display'], source: 'upload', category: 'serif', files: ['v'], weights: [100, 900], italic: [] },
      { family: 'Brand', roles: ['body', 'accent'], source: 'upload', files: ['r', 'b'], weights: [400, 700], italic: [] },
    ]);
    expect(plan.google_css_url).toBeNull();
    // Before version 15 every file of the family is published, and Google is not asked for it.
    const legacy = planSiteFonts({ heading: 'Inter', body: 'Brand' }, usage({}), { renderVersion: 14, library });
    expect(legacy.families.find(family => family.family === 'Brand')?.files).toEqual(['r', 'b', 'k', 'i']);
    expect(legacy.google_css_url).toBe(googleFontsCssUrl(['Inter']));
  });

  it('leaves service families to their stylesheet', () => {
    const services = [{ provider: 'adobe' as const, kit: 'abc1234', families: ['proxima-nova'] }, { provider: 'bunny' as const, url: 'https://fonts.bunny.net/css?family=inter:400', families: ['Inter'] }];
    const plan = planSiteFonts({ heading: 'proxima-nova', body: 'Lato', services }, usage({}), { renderVersion: 15 });
    expect(plan.families[0]).toMatchObject({ family: 'proxima-nova', source: 'service' });
    expect(plan.service_stylesheets).toEqual(['https://use.typekit.net/abc1234.css', 'https://fonts.bunny.net/css?family=inter:400']);
    expect(plan.google_css_url).toBe('https://fonts.googleapis.com/css2?family=Lato:wght@400&display=swap');
    expect(planSiteFonts({ heading: 'proxima-nova', body: 'Lato', services }, usage({}), { renderVersion: 14 }).google_css_url).toBe(googleFontsCssUrl(['Lato']));
  });
});

describe('font settings', () => {
  it('validates roles, load and services', () => {
    expect(siteFontsErrors({ heading: 'Inter', body: 'Inter', display: 'Playfair Display', load: { body: { weights: [300], italic: [400] } }, services: [{ provider: 'adobe', kit: 'abc1234', families: ['proxima-nova'] }] })).toEqual([]);
    expect(siteFontsErrors({ display: "x'; }<script>" })).toEqual(['fonts.display must be a font family name (letters, digits, spaces; at most 80 characters)']);
    expect(siteFontsErrors({ load: { serif: {}, body: { weights: [450] } } })).toEqual(['fonts.load.serif is not a font role (heading, body, mono, display, accent)', 'fonts.load.body.weights must list weights 100–900 in steps of 100']);
    expect(siteFontsErrors({ services: [{ provider: 'bunny', url: 'https://evil.example/css', families: [] }, { provider: 'adobe', kit: 'A!', families: ['x'] }] })).toEqual([
      'fonts.services[0].url must be a https://fonts.bunny.net/css stylesheet URL',
      'fonts.services[1].kit must be an Adobe Fonts web project ID (5–12 lowercase letters and digits)',
    ]);
    expect(siteFontsErrors({ display: null, accent: null })).toEqual([]);
  });

  it('recognises service stylesheets and their families', () => {
    expect(fontServiceProvider('https://fonts.bunny.net/css2?family=inter:wght@400')).toBe('bunny');
    expect(fontServiceProvider('https://api.fontshare.com/v2/css?f[]=satoshi@400&display=swap')).toBe('fontshare');
    expect(fontServiceProvider('http://fonts.bunny.net/css')).toBeNull();
    expect(fontServiceStylesheet({ provider: 'adobe', kit: 'xyz9876', families: [] })).toBe('https://use.typekit.net/xyz9876.css');
    expect(serviceStylesheetFamilies('@font-face{font-family:"proxima-nova";src:url(x)}@font-face{font-family:Satoshi-Variable;font-weight:300 900}@font-face{font-family:"proxima-nova"}')).toEqual(['proxima-nova', 'Satoshi-Variable']);
  });

  it('falls back display to heading and accent to body', () => {
    expect(fontRoleFamilies({ heading: 'Lato', body: 'Inter' })).toEqual({ heading: 'Lato', body: 'Inter', mono: undefined, display: 'Lato', accent: 'Inter' });
    expect(fontRoleFamilies(undefined).heading).toBe('Inter');
  });

  it('lets styles choose display and accent', () => {
    const style = { id: 'hero', name: 'Hero', targets: ['heading'], base: { font: 'display' } } as SiteStyle;
    expect(validateSiteStyle(style).errors).toEqual([]);
    expect(siteStylesCss([style], { breakpoints: resolveBreakpointWidths(undefined), colors: {}, renderVersion: 15 })).toContain("var(--font-display, var(--font-heading))");
  });
});

describe('searchFontCatalog', () => {
  it('ranks exact names, then prefixes, then words, then substrings', () => {
    expect(searchFontCatalog({ query: 'inter' })[0].family).toBe('Inter');
    expect(searchFontCatalog({ query: 'display' }).every(font => /display/i.test(font.family))).toBe(true);
    expect(searchFontCatalog({ query: 'zz-no-such-font' })).toEqual([]);
  });

  it('filters by category, variable axes, italics and extended Latin', () => {
    const serif = searchFontCatalog({ category: 'serif', variable: true, italic: true, latin_ext: true, limit: 500 });
    expect(serif.length).toBeGreaterThan(5);
    expect(serif.every(font => font.category === 'serif' && font.variable && font.italic?.length && font.latin_ext)).toBe(true);
    expect(searchFontCatalog({ limit: 3 })).toHaveLength(3);
  });

  it('writes previews in the site language', () => {
    expect(fontSampleText('sv').body).toMatch(/åäö/);
    expect(fontSampleText('en-GB').heading).toMatch(/quick brown fox/);
    expect(fontSampleText('xx').heading).toBe(fontSampleText('en').heading);
  });
});

describe('font CSS', () => {
  const plan: FontPlan = {
    render_version: 15, google_css_url: null, service_stylesheets: [],
    families: [{ family: 'Lato', roles: ['heading'], source: 'google', weights: [700], italic: [], fallback: { local: ['Arial', 'ArialMT'], size_adjust: 97.4, ascent: 102.6, descent: 22.15, line_gap: 0 } }],
  };

  it('defines the display and accent roles from render version 15 only', () => {
    const v14 = siteThemeCss({ ...defaultSiteSettings, render_version: 14 });
    expect(v14).not.toMatch(/--font-display|data-font="display"/);
    const v15 = siteThemeCss({ ...defaultSiteSettings, render_version: 15 });
    expect(v15).toContain('--font-display:var(--font-heading);');
    expect(v15).toContain('--font-accent:var(--font-body);');
    expect(v15).toContain('[data-font="display"]{font-family:var(--font-display)}');
    const chosen = siteThemeCss({ ...defaultSiteSettings, fonts: { ...defaultSiteSettings.fonts, display: 'Playfair Display' }, render_version: 15 });
    expect(chosen).toContain("--font-display:'Playfair Display', 'tr-fallback'");
  });

  it('puts a family’s own fallback face before the generic one', () => {
    const settings = { ...defaultSiteSettings, fonts: { ...defaultSiteSettings.fonts, heading: 'Lato' }, render_version: 15, font_plan: plan };
    expect(siteThemeCss(settings)).toContain("--font-heading:'Lato', 'Lato fallback', 'tr-fallback'");
    expect(siteThemeCss({ ...settings, render_version: 14 })).toContain("--font-heading:'Lato', 'tr-fallback'");
    expect(fontFallbackFacesCss(plan)).toBe("@font-face{font-family:'Lato fallback';src:local('Arial'),local('ArialMT');size-adjust:97.4%;ascent-override:102.6%;descent-override:22.15%;line-gap-override:0%}");
    expect(webfontFallbackCss(15, plan)).toBe(webfontFallbackCss(14) + fontFallbackFacesCss(plan));
    expect(webfontFallbackCss(14, plan)).toBe(webfontFallbackCss(14));
  });
});
