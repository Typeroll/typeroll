import { describe, it, expect } from 'vitest';
import {
  STANDARD_STYLES,
  buildCoreBlockRegistry,
  contrastRatio,
  defaultSiteSettings,
  onColor,
  renderBlocks,
  resolveBreakpointWidths,
  siteStyleLibraryErrors,
  siteStylesCss,
  styleContrastErrors,
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
    expect(styleContrastErrors(grey, colors).join()).toMatch(/below 4.5:1/);
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

  it('ships standard styles that pass on the default palette', () => {
    for (const style of STANDARD_STYLES) expect(styleContrastErrors(style, colors), style.id).toEqual([]);
    expect(siteStyleLibraryErrors([...STANDARD_STYLES])).toEqual([]);
    for (const style of STANDARD_STYLES) expect(validateSiteStyle(style).errors, style.id).toEqual([]);
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
});
