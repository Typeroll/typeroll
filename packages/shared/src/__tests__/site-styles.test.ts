import { describe, it, expect } from 'vitest';
import {
  STANDARD_STYLES,
  buildCoreBlockRegistry,
  contrastRatio,
  defaultSiteSettings,
  onColor,
  onColorContrasts,
  onColorValue,
  onColorWarnings,
  renderBlocks,
  resolveBreakpointWidths,
  siteStyleLibraryErrors,
  siteStylesCss,
  styleContrastErrors,
  styleContrastReport,
  styleTextUse,
  stylesForTarget,
  validateSiteStyle,
} from '../index.js';
import type { SiteStyle } from '../index.js';

const colors = defaultSiteSettings.colors;
const opts = { breakpoints: resolveBreakpointWidths(undefined), colors };
const eyebrow: SiteStyle = { id: 'eyebrow', name: 'Eyebrow', targets: ['text', 'heading'], base: { size: '0.8rem', weight: 700, transform: 'uppercase', color: 'primary' }, at: { desktop: { size: '0.9rem' } } };

describe('validateSiteStyle', () => {
  it('accepts structured values and normalizes the style', () => {
    const { style, errors } = validateSiteStyle({ ...eyebrow, name: '  Eyebrow  ' });
    expect(errors).toEqual([]);
    expect(style?.name).toBe('Eyebrow');
  });

  it('rejects unknown keys, unsafe values and injected CSS', () => {
    const cases: [unknown, RegExp][] = [
      [{ ...eyebrow, id: 'Bad Id' }, /id must/],
      [{ ...eyebrow, base: { size: '12px;color:red' } }, /size must/],
      [{ ...eyebrow, base: { color: 'url(javascript:alert(1))' } }, /color must/],
      [{ ...eyebrow, base: { colour: 'red' } }, /not a style property/],
      [{ ...eyebrow, at: { phone: {} } }, /not a breakpoint/],
      [{ ...eyebrow, css: '</style><script>alert(1)</script>' }, /markup/],
      [{ ...eyebrow, css: '& { color: red' }, /unmatched/],
      [{ ...eyebrow, role: 'hero' }, /role must/],
    ];
    for (const [input, message] of cases) expect(validateSiteStyle(input).errors.join('\n')).toMatch(message);
  });

  it('sets opacity, a shadow preset and gap', () => {
    const style = validateSiteStyle({ id: 'soft', name: 'Soft', targets: ['container', 'link', 'image'], base: { opacity: 0.8, shadow: 'none', gap: '1rem 2rem' } }).style!;
    expect(siteStylesCss([style], opts)).toContain('.s-soft:not(#\\#){opacity:0.8;box-shadow:none;gap:1rem 2rem}');
    expect(validateSiteStyle({ ...style, base: { opacity: 2 } }).errors).toEqual(['base.opacity must be a number from 0 to 1']);
    expect(validateSiteStyle({ ...style, base: { shadow: '0 0 4px red' } }).errors[0]).toContain('base.shadow must be one of none, sm, md, lg');
    expect(validateSiteStyle({ ...style, base: { gap: '1rem 2rem 3rem' } }).errors).toEqual(['base.gap must be one or two CSS lengths']);
  });

  it('flags duplicate ids and roles in a library', () => {
    expect(siteStyleLibraryErrors([eyebrow, { ...eyebrow }]).join()).toMatch(/Duplicate style id/);
    expect(siteStyleLibraryErrors([{ ...eyebrow, role: 'eyebrow' }, { ...eyebrow, id: 'kicker', role: 'eyebrow' }]).join()).toMatch(/role "eyebrow"/);
  });
});

describe('contrast', () => {
  it('computes WCAG ratios', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 0);
    expect(contrastRatio('#777777', '#ffffff')).toBeCloseTo(4.48, 1);
  });

  it('never allows light grey on white', () => {
    const grey: SiteStyle = { id: 'note', name: 'Note', targets: ['text'], base: { color: '#c0c0c0' } };
    expect(styleContrastErrors(grey, colors).join()).toMatch(/#c0c0c0 on #ffffff is APCA Lc 3\d\.\d, WCAG 2 1\.\d\d:1\. 16px\/400 body text needs APCA Lc 75 or WCAG 2 4\.5:1/);
    expect(styleContrastErrors({ ...grey, base: { color: '#c0c0c0', background: '#1f2937' } }, colors)).toEqual([]);
  });

  it('accepts 3:1 for large text only', () => {
    const big: SiteStyle = { id: 'big', name: 'Big', targets: ['heading'], base: { color: '#8a8a8a', size: '2rem' } };
    expect(styleContrastErrors(big, colors)).toEqual([]);
    expect(styleContrastErrors({ ...big, base: { ...big.base, size: '1rem' } }, colors).length).toBe(1);
  });

  it('derives readable text for any palette colour', () => {
    expect(onColor('#3b82f6')).toBe('#111827');
    expect(onColor('#1e293b')).toBe('#ffffff');
  });

  it('chooses the automatic on-colour by APCA from render version 8', () => {
    for (const version of [1, 2, 3, 4, 5, 6, 7]) expect(onColor('#00a19c', version)).toBe('#111827');
    expect(onColor('#00a19c', 8)).toBe('#ffffff');
    expect(onColor('#3b82f6', 8)).toBe('#ffffff');
    expect(onColor('#f59e0b', 8)).toBe('#111827');
  });

  it('uses an explicit on-colour on every render version', () => {
    const moveria = { ...colors, secondary: '#00a19c', on_secondary: '#ffffff' };
    for (const version of [1, 7, 8]) expect(onColorValue('on_secondary', moveria, version)).toBe('#ffffff');
    // Anything that is not an opaque hex colour falls back to the automatic choice.
    expect(onColorValue('on_secondary', { ...moveria, on_secondary: 'red;}' }, 7)).toBe('#111827');
    expect(onColorValue('on_secondary', { ...moveria, on_secondary: '#ffffff80' }, 7)).toBe('#111827');
  });

  it('classifies how a style is read', () => {
    expect(styleTextUse({ role: 'button', targets: ['button'] })).toBe('content');
    expect(styleTextUse({ role: 'h3', targets: [] })).toBe('content');
    expect(styleTextUse({ role: 'small', targets: ['text'] })).toBe('sub_fluent');
    expect(styleTextUse({ role: 'link', targets: [] })).toBe('body');
    expect(styleTextUse({ targets: ['heading', 'button'] })).toBe('content');
    expect(styleTextUse({ targets: ['heading', 'text'] })).toBe('body');
    expect(styleTextUse({ targets: [] })).toBe('body');
  });

  it('accepts white 16px/600 button text on #00a19c, chosen or automatic (version 8)', () => {
    const teal = { ...colors, primary: '#00a19c' };
    const button = STANDARD_STYLES.find(style => style.role === 'button')!;
    expect(styleContrastReport(button, { ...teal, on_primary: '#ffffff' })).toEqual({ errors: [], warnings: [] });
    expect(styleContrastReport(button, teal, { renderVersion: 8 })).toEqual({ errors: [], warnings: [] });
    // White as body text on it is below Lc 75 and below WCAG 2 AA: refused.
    const panel: SiteStyle = { id: 'panel', name: 'Panel', targets: ['container'], base: { color: '#ffffff', background: 'primary' } };
    expect(styleContrastErrors(panel, teal).join()).toMatch(/#ffffff on #00a19c is APCA Lc 63\.9, WCAG 2 3\.19:1\. 16px\/400 body text needs APCA Lc 75/);
  });

  it('warns, without refusing, when only WCAG 2 accepts a pair', () => {
    const teal = { ...colors, primary: '#00a19c' };
    const button = STANDARD_STYLES.find(style => style.role === 'button')!;
    // Render version 7 picks #111827 by WCAG 2 (5.56:1, Lc 44).
    const report = styleContrastReport(button, teal, { renderVersion: 7 });
    expect(report.errors).toEqual([]);
    expect(report.warnings).toEqual([
      'Button (base): #111827 on #00a19c is APCA Lc 44.0, WCAG 2 5.56:1: below APCA Lc 60 for 16px/600 non-body text, accepted because it meets WCAG 2 AA (4.5:1). Render version 8 chooses #ffffff for on_primary here; or set colors.on_primary.',
    ]);
    expect(styleContrastReport(button, { ...teal, on_primary: '#111827' }).warnings[0]).not.toContain('Render version 8');
  });

  it('checks hover colours with the style\'s size and weight', () => {
    const button = STANDARD_STYLES.find(style => style.role === 'button')!;
    const hover = { ...button, hover: { background: '#9ca3af' } };
    expect(styleContrastReport(hover, colors).errors.join()).toMatch(/Button \(hover\): #ffffff on #9ca3af/);
  });

  it('ships standard styles that pass on the default palette', () => {
    for (const version of [1, 8]) for (const style of STANDARD_STYLES) expect(styleContrastReport(style, colors, { renderVersion: version }), style.id).toEqual({ errors: [], warnings: [] });
    expect(siteStyleLibraryErrors([...STANDARD_STYLES])).toEqual([]);
    for (const style of STANDARD_STYLES) expect(validateSiteStyle(style).errors, style.id).toEqual([]);
  });
});

describe('on-colour contrast', () => {
  it('reports the measures of every on-colour', () => {
    const report = onColorContrasts({ ...colors, secondary: '#00a19c', on_secondary: '#ffffff' }, 8);
    expect(report.map(item => [item.token, item.text, item.explicit, item.apca_pass])).toEqual([
      ['on_primary', '#ffffff', false, true],
      ['on_secondary', '#ffffff', true, true],
      ['on_accent', '#111827', false, true],
    ]);
    expect(report[1].wcag).toBeCloseTo(3.19, 2);
  });

  it('warns about a clearly unreadable explicit choice and keeps it', () => {
    expect(onColorWarnings({ ...colors, secondary: '#00a19c', on_secondary: '#ffffff' }, 8)).toEqual([]);
    expect(onColorWarnings({ ...colors, secondary: '#00a19c', on_secondary: '#111827' }, 8)).toEqual([
      'colors.on_secondary #111827 on secondary #00a19c is APCA Lc 44.0, WCAG 2 5.56:1, below APCA Lc 60 for 16px/600 non-body text such as buttons. The automatic choice would be #ffffff (APCA Lc 63.9, WCAG 2 3.19:1).',
    ]);
    // The automatic choice is not the site's: no warning.
    expect(onColorWarnings({ ...colors, primary: '#9ca3af' }, 8)).toEqual([]);
    const css = siteStylesCss([], { ...opts, renderVersion: 8, colors: { ...colors, secondary: '#00a19c', on_secondary: '#111827' } });
    expect(css).toContain('--color-on-secondary:#111827');
  });
});

describe('siteStylesCss', () => {
  it('is empty without styles, so existing sites are unchanged', () => {
    expect(siteStylesCss(undefined, opts)).toBe('');
    expect(siteStylesCss([], opts)).toBe('');
  });

  it('emits element roles as variables and class styles as boosted classes per breakpoint', () => {
    const css = siteStylesCss([...STANDARD_STYLES.filter(s => s.role === 'h2'), eyebrow], opts);
    expect(css).toContain('--type-h2:1.5rem');
    expect(css).toMatch(/@media \(min-width:1280px\)\{:root\{[^}]*--type-h2:2.25rem/);
    expect(css).toContain('.s-eyebrow:not(#\\#){font-size:0.8rem;font-weight:700;text-transform:uppercase;color:var(--color-primary)}');
    expect(css).toContain('@media (min-width:1280px){.s-eyebrow:not(#\\#){font-size:0.9rem}}');
    expect(css).toContain('--color-on-primary:#ffffff');
  });

  it('drops stored styles that fail validation', () => {
    expect(siteStylesCss([{ ...eyebrow, base: { size: '1px}</style>' } }], opts)).toBe('');
  });

  it('scopes advanced CSS to the style', () => {
    const css = siteStylesCss([{ ...eyebrow, css: '&::after { content: ""; }' }], opts);
    expect(css).toContain('.s-eyebrow:not(#\\#)::after { content: ""; }');
  });

  it('lists only selectable styles for a block kind', () => {
    expect(stylesForTarget(STANDARD_STYLES, 'heading').map(s => s.id)).toEqual(['eyebrow']);
    expect(stylesForTarget(STANDARD_STYLES, 'button').map(s => s.id)).toEqual(['button', 'button-secondary']);
  });
});

describe('block style_id', () => {
  const registry = buildCoreBlockRegistry();
  it('puts the class on the semantic element', () => {
    const heading = renderBlocks([{ id: 'h', type: 'core/heading', data: { text: 'Hi', level: 'h2', style_id: 'eyebrow' } }], { registry });
    expect(heading).toContain('<h2 class="block-heading-text s-eyebrow">Hi</h2>');
    const prose = renderBlocks([{ id: 'p', type: 'core/prose', data: { html: '<p>x</p>', style_id: 'lead' } }], { registry });
    expect(prose).toMatch(/^<div data-block="prose"[^>]*class="s-lead"/);
    const button = renderBlocks([{ id: 'b', type: 'core/button', data: { label: 'Go', href: '/go', style_id: 'button' } }], { registry });
    expect(button).toContain('class="block-button-link s-button"');
  });

  it('ignores invalid ids and blocks whose own "style" field is a variant', () => {
    expect(renderBlocks([{ id: 'h', type: 'core/heading', data: { text: 'Hi', style_id: 'Bad id"' } }], { registry })).not.toContain('s-');
    expect(renderBlocks([{ id: 't', type: 'core/testimonial', data: { quote: 'q', style: 'card', style_id: 'lead' } }], { registry })).not.toContain('s-lead');
  });
});

describe('render version 2', () => {
  const registry = buildCoreBlockRegistry();
  const heading = { id: 'h', type: 'core/heading', data: { text: 'Title', level: 'h2', eyebrow: 'For leaders', subtitle: 'In one day', eyebrow_style_id: 'kicker' } };

  it('keeps version 1 heading markup', () => {
    const html = renderBlocks([heading], { registry });
    expect(html).toContain('<span class="block-heading-eyebrow">For leaders</span>');
    expect(html).not.toContain('In one day');
    expect(html).not.toContain('<hgroup');
  });

  it('groups eyebrow, heading and subtitle and styles each part', () => {
    const html = renderBlocks([heading], { registry, renderVersion: 2 });
    expect(html).toMatch(/<hgroup class="block-heading-group">\s*<p class="block-heading-eyebrow s-kicker">For leaders<\/p>\s*<h2 class="block-heading-text">Title<\/h2>\s*<p class="block-heading-subtitle tr-role-lead">In one day<\/p><\/hgroup>/);
  });

  it('omits the group and empty parts for a plain heading', () => {
    const html = renderBlocks([{ id: 'h', type: 'core/heading', data: { text: 'Title', level: 'h3' } }], { registry, renderVersion: 2 });
    expect(html).not.toContain('hgroup');
    expect(html).not.toContain('eyebrow');
  });

  it('puts a custom class on the heading element itself', () => {
    const block = { ...heading, style_overrides: { custom_class: 'eyebrow-like', html_id: 'intro' } };
    expect(renderBlocks([block], { registry })).toMatch(/<div data-block="heading"[^>]*id="intro" class="eyebrow-like"/);
    const html = renderBlocks([block], { registry, renderVersion: 2 });
    expect(html).toContain('<h2 class="block-heading-text eyebrow-like">');
    expect(html).toMatch(/<div data-block="heading"[^>]*id="intro"/);
  });

  it('styles default eyebrow and subtitle with the first style of that role', () => {
    const styles = [{ ...eyebrow, role: 'eyebrow' }, { ...eyebrow, id: 'eyebrow-2', role: 'eyebrow' }, STANDARD_STYLES.find(style => style.role === 'lead')!];
    expect(siteStylesCss(styles, opts)).not.toContain('tr-role');
    const css = siteStylesCss(styles, { ...opts, renderVersion: 2 });
    expect(css).toContain('.s-eyebrow:not(#\\#),.tr-role-eyebrow:not(#\\#){');
    expect(css).not.toContain('.s-eyebrow-2:not(#\\#),.tr-role-eyebrow');
    expect(css).toContain('.s-lead:not(#\\#),.tr-role-lead:not(#\\#){');
  });

  it('derives a readable --color-primary-fg, even without styles', () => {
    expect(siteStylesCss([], opts)).toBe('');
    const css = siteStylesCss([], { ...opts, renderVersion: 2, colors: { ...colors, primary: '#facc15' } });
    expect(css).toContain(':where(:root){--color-primary-fg:var(--color-on-primary)}');
    expect(css).toContain('--color-on-primary:#111827');
  });

  it('emits an explicit on-colour on every render version', () => {
    const moveria = { ...colors, primary: '#00a19c', secondary: '#00a19c', on_primary: '#ffffff', on_secondary: '#fff' };
    const v1 = siteStylesCss([], { ...opts, colors: moveria });
    expect(v1).toContain('--color-on-primary:#ffffff;--color-on-secondary:#fff;--color-on-accent:#111827');
    // Blocks read --color-primary-fg and --color-secondary-fg, which versions 1 and 2 do not define otherwise.
    expect(v1).toContain(':where(:root){--color-primary-fg:var(--color-on-primary)}');
    expect(v1).toContain(':where(:root){--color-secondary-fg:var(--color-on-secondary)}');
    const v3 = siteStylesCss([], { ...opts, colors: moveria, renderVersion: 3 });
    expect(v3.match(/--color-secondary-fg/g)).toHaveLength(1);
    expect(siteStylesCss([], { ...opts, colors: { ...colors, on_accent: '#000' } })).toBe(':root{--color-on-primary:#ffffff;--color-on-secondary:#ffffff;--color-on-accent:#000}');
    // A stored value that is not an opaque hex colour never reaches the stylesheet.
    expect(siteStylesCss([], { ...opts, colors: { ...colors, on_primary: 'red}</style>' } })).toBe('');
  });

  it('defines the theme tokens blocks reference from the palette in version 3', () => {
    const tokens = '--color-bg:var(--color-background);--color-bg-subtle:var(--color-surface)';
    expect(siteStylesCss([], { ...opts, renderVersion: 2 })).not.toContain(tokens);
    const css = siteStylesCss([], { ...opts, renderVersion: 3 });
    expect(css).toContain(`:where(:root){${tokens};--color-border:color-mix(`);
    expect(css).toContain('--color-secondary-fg:var(--color-on-secondary)');
    expect(css).toContain('--color-on-secondary:');
  });
});
