import { describe, expect, it } from 'vitest';
import {
  LATEST_RENDER_VERSION,
  blockFieldTypeWarnings,
  blockPartQuery,
  blockPartSelector,
  blockPartSelectorError,
  blockPartStylesCss,
  buildCoreBlockRegistry,
  collectBlockAssets,
  defaultSiteSettings,
  partStyleIssues,
  renderBlocks,
  resolveBreakpointWidths,
  siteStyleLibraryErrors,
  styleContrastReport,
  stylePartErrors,
  stylePartSurfaces,
  treePartStyleIssues,
  unknownBlockDataFields,
  validateBlockTypeDefinition,
  validateSiteStyle,
  type Block,
  type BlockType,
  type SiteStyle,
} from '../index.js';

const registry = buildCoreBlockRegistry();
const breakpoints = resolveBreakpointWidths(undefined);
const colors = defaultSiteSettings.colors;
const quietLink: SiteStyle = { id: 'quiet-link', name: 'Quiet link', targets: ['link'], base: { decoration: 'none' }, hover: { decoration: 'underline' } };
const loudLink: SiteStyle = { id: 'loud-link', name: 'Loud link', targets: ['link'], base: { decoration: 'underline', weight: 700 } };
const heading = (id: string, data: Record<string, unknown> = {}): Block => ({ id, type: 'core/rich_heading', data: { level: 'h2', html: '<a href="/x/">Link</a>', ...data } });
const assets = (blocks: Block[], styles: unknown[] | undefined) => collectBlockAssets(blocks, registry, { renderVersion: LATEST_RENDER_VERSION, siteStyles: { styles, breakpoints } }).css;

describe('part selectors', () => {
  it('accepts plain selectors relative to the block root', () => {
    for (const selector of ['a', '.block-hero-heading', '.block-hero-media img', 'li > a', '.x:first-child', 'a[href]', 'p.lead, .note', 'td:nth-child(2n+1)', '> .col', '> .strip > a, > .links a']) {
      expect(blockPartSelectorError(selector), selector).toBeNull();
    }
  });

  it('rejects anything that could reach outside the generated rule', () => {
    for (const selector of ['', 'a{color:red}', 'a;b', '@media', 'a::before', 'a:hover', 'a /* x */', '<a>', '* ', '+ a', '~ a', '>', '> > a', 'a >', 'a\\b', 'a, b, c, d, e', "a[href='x']", 'x'.repeat(201)]) {
      expect(blockPartSelectorError(selector), selector).not.toBeNull();
    }
  });

  it('builds one rule shape with a fixed (2,1,0) specificity', () => {
    const type = registry.get('core/rich_heading')!;
    const part = type.parts![0]!;
    expect(blockPartSelector(type, part)).toBe(':where([data-block="rich_heading"]:not([data-part-link]) a):not([class^="s-"],[class*=" s-"]):not(#\\#):not(#\\#)');
    expect(blockPartSelector(type, part, 'quiet-link')).toBe(':where([data-block="rich_heading"][data-part-link="quiet-link"] a):not([class^="s-"],[class*=" s-"]):not(#\\#):not(#\\#)');
    expect(blockPartSelector(type, part, 'Bad id')).toBeNull();
    expect(blockPartSelector(type, { ...part, selector: '> .a' })).toBe(':where([data-block="rich_heading"]:not([data-part-link]) > .a):not([class^="s-"],[class*=" s-"]):not(#\\#):not(#\\#)');
    expect(blockPartQuery('> .a, .b c')).toBe(':scope > .a, :scope .b c');
    expect(blockPartSelector(type, { ...part, selector: '.a, .b' })).toBe(':where([data-block="rich_heading"]:not([data-part-link]) .a,[data-block="rich_heading"]:not([data-part-link]) .b):not([class^="s-"],[class*=" s-"]):not(#\\#):not(#\\#)');
  });
});

describe('part style CSS', () => {
  it('is absent when nothing is set, so existing output is unchanged', () => {
    const blocks = [heading('a'), { id: 'h', type: 'core/hero', data: { heading: 'Hi' } } as Block];
    const without = collectBlockAssets(blocks, registry, { renderVersion: LATEST_RENDER_VERSION }).css;
    expect(assets(blocks, [])).toBe(without);
    expect(assets(blocks, [quietLink])).toBe(without);
    expect(assets(blocks, undefined)).toBe(without);
    expect(renderBlocks(blocks, { registry })).not.toContain('data-part-');
  });

  it('applies a site-wide part style to the block types on the page', () => {
    const css = assets([heading('a')], [{ ...quietLink, parts: ['core/rich_heading.link'] }]);
    expect(css).toContain('/* block parts */\n:where([data-block="rich_heading"]:not([data-part-link]) a):not([class^="s-"],[class*=" s-"]):not(#\\#):not(#\\#){text-decoration:none}');
    expect(css).toContain(':not(#\\#):not(#\\#):hover{text-decoration:underline;text-underline-offset:.15em}');
    // Not on a page without the block, and not from a style of another kind.
    expect(assets([{ id: 'p', type: 'core/prose', data: { html: '<p>x</p>' } }], [{ ...quietLink, parts: ['core/rich_heading.link'] }])).not.toContain('block parts');
    expect(assets([heading('a')], [{ ...quietLink, targets: ['text'], parts: ['core/rich_heading.link'] }])).not.toContain('block parts');
  });

  it('lets an instance replace the site-wide style for one part', () => {
    const blocks = [heading('a'), heading('b', { part_styles: { link: 'loud-link' } })];
    const html = renderBlocks(blocks, { registry });
    expect(html.match(/data-part-link="loud-link"/g)).toHaveLength(1);
    const css = assets(blocks, [{ ...quietLink, parts: ['core/rich_heading.link'] }, loudLink]);
    expect(css).toContain(':where([data-block="rich_heading"][data-part-link="loud-link"] a):not([class^="s-"],[class*=" s-"]):not(#\\#):not(#\\#){font-weight:700;text-decoration:underline;text-underline-offset:.15em}');
    // An unknown or unfitting style renders no rule.
    expect(assets([heading('c', { part_styles: { link: 'missing' } })], [loudLink])).not.toContain('block parts');
  });

  it('emits breakpoints and advanced CSS on the part selector', () => {
    const style: SiteStyle = { id: 'big', name: 'Big', targets: ['heading'], base: { size: '2rem' }, at: { desktop: { size: '3rem' } }, css: 'letter-spacing:-0.02em', parts: ['core/hero.heading'] };
    const css = blockPartStylesCss([{ id: 'h', type: 'core/hero', data: {} }], registry, ['core/hero'], { styles: [style], breakpoints });
    expect(css).toContain(`@media (min-width:${breakpoints.desktop}px){:where([data-block="hero"]:not([data-part-heading]) .block-hero-heading)`);
    expect(css).toContain(':not(#\\#):not(#\\#){letter-spacing:-0.02em}');
  });

  it('reaches repeater items through item_overrides', () => {
    const repeater: Block = { id: 'r', type: 'core/repeater', data: { source_type: 'static', item_block: 'core/hero', items: [{ heading: 'A' }], item_overrides: { part_styles: { heading: 'big' } } } };
    const css = blockPartStylesCss([repeater], registry, ['core/repeater', 'core/hero'], { styles: [{ id: 'big', name: 'Big', targets: ['heading'], base: { size: '2rem' } }], breakpoints });
    expect(css).toContain('[data-part-heading="big"]');
  });

  it('marks every repeater root, groups and aliases included, and anchors at it', () => {
    const pill: SiteStyle = { id: 'pill', name: 'Pill', targets: ['button'], base: { radius: '999px' } };
    const items = [{ html: '<p>A</p>', kind: 'x' }, { html: '<p>B</p>', kind: 'y' }];
    const carousel: Block = { id: 'r', type: 'core/repeater', data: { item_block: 'core/prose', layout: 'carousel', items, part_styles: { carousel_button: 'pill' } } };
    expect(renderBlocks([carousel], { registry, renderVersion: LATEST_RENDER_VERSION })).toMatch(/^<div data-block="repeater"[^>]* data-part-carousel_button="pill">/);
    expect(assets([carousel], [pill])).toContain(':where([data-block="repeater"][data-part-carousel_button="pill"] > .tr-carousel-controls > .tr-carousel-button)');
    const grouped: Block = { ...carousel, data: { ...carousel.data, group_by: 'kind' } };
    expect(renderBlocks([grouped], { registry, renderVersion: LATEST_RENDER_VERSION }).match(/<div data-block="repeater"[^>]* data-part-carousel_button="pill"/g)).toHaveLength(2);
    // Group titles sit outside the roots; their own style field reaches them.
    expect(renderBlocks([{ ...grouped, data: { ...grouped.data, group_title_style_id: 'eyebrow' } }], { registry }).match(/class="tr-repeater-group-title s-eyebrow"/g)).toHaveLength(2);
    expect(renderBlocks([grouped], { registry })).toContain('class="tr-repeater-group-title">');
    // An alias renders as core/repeater and shares its parts.
    const testimonials: Block = { id: 't', type: 'core/testimonials', data: { layout: 'carousel', items: [{ quote: 'A' }, { quote: 'B' }], part_styles: { carousel_button: 'pill' } } };
    expect(unknownBlockDataFields(testimonials, registry)).toEqual([]);
    expect(renderBlocks([testimonials], { registry, renderVersion: LATEST_RENDER_VERSION })).toContain('data-part-carousel_button="pill"');
    expect(assets([testimonials], [pill])).toContain('[data-part-carousel_button="pill"] > .tr-carousel-controls > .tr-carousel-button');
    expect(treePartStyleIssues([{ ...testimonials, data: { ...testimonials.data, part_styles: { carousel_button: 'missing' } } }], registry, [pill])).toEqual([expect.objectContaining({ code: 'unknown_style', block_type: 'core/repeater' })]);
    // Without a choice the markup is unchanged.
    expect(renderBlocks([{ ...carousel, data: { ...carousel.data, part_styles: undefined } }], { registry })).not.toContain('data-part-');
  });

  it('orders rules by part, so a later part wins where parts overlap', () => {
    const nav: Block = { id: 'n', type: 'core/navigation_links', data: { links: [{ label: 'Home', href: '/' }], part_styles: { link: 'loud-link' } } };
    const current: SiteStyle = { id: 'current', name: 'Current', targets: ['link'], base: { weight: 800 }, parts: ['core/navigation_links.current_link'] };
    // The library lists the current-link style first; its rule still follows every link rule.
    const css = assets([nav], [current, { ...quietLink, parts: ['core/navigation_links.link'] }, loudLink]);
    const at = (needle: string) => css.indexOf(needle);
    expect(at(':not([data-part-link]) > li > a)')).toBeGreaterThan(-1);
    expect(at('[data-part-link="loud-link"] > li > a)')).toBeGreaterThan(at(':not([data-part-link]) > li > a)'));
    expect(at('> li > a[aria-current="page"])')).toBeGreaterThan(at('[data-part-link="loud-link"] > li > a)'));
  });

  it('skips a part before its render version', () => {
    const style: SiteStyle = { id: 'sub', name: 'Sub', targets: ['text'], base: { size: '1rem' }, parts: ['core/heading.subtitle'] };
    const blocks: Block[] = [{ id: 'h', type: 'core/heading', data: { text: 'H' } }];
    expect(blockPartStylesCss(blocks, registry, ['core/heading'], { styles: [style], breakpoints, renderVersion: 1 })).toBe('');
    expect(blockPartStylesCss(blocks, registry, ['core/heading'], { styles: [style], breakpoints, renderVersion: 2 })).toContain('.block-heading-subtitle');
  });
});

describe('part_styles data', () => {
  it('rejects a part an instance cannot style, with suggestions', () => {
    const [issue] = unknownBlockDataFields(heading('a', { part_styles: { lnk: 'quiet-link' } }), registry);
    expect(issue).toEqual(expect.objectContaining({ code: 'unknown_field', path: 'data.part_styles.lnk', suggestions: ['link'] }));
    // core/heading's parts have style fields of their own.
    const [own] = unknownBlockDataFields({ type: 'core/heading', data: { text: 'H', part_styles: { eyebrow: 'small' } } }, registry);
    expect(own).toEqual(expect.objectContaining({ code: 'unknown_field', path: 'data.part_styles', suggestions: ['eyebrow_style_id', 'style_id', 'subtitle_style_id'] }));
    expect(unknownBlockDataFields(heading('a', { part_styles: { link: 'quiet-link' } }), registry)).toEqual([]);
  });

  it('reports values that are not style ids', () => {
    const warnings = blockFieldTypeWarnings([heading('a', { part_styles: { link: 'Quiet Link' } }), heading('b', { part_styles: 'quiet-link' })], registry);
    expect(warnings.map(warning => [warning.code, warning.path])).toEqual([
      ['field_type_mismatch', 'blocks[0].data.part_styles.link'],
      ['field_type_mismatch', 'blocks[1].data.part_styles'],
    ]);
  });

  it('checks style ids, kinds and contrast against the part', () => {
    const type = registry.get('core/hero')!;
    const styles: SiteStyle[] = [
      { id: 'ghost-button', name: 'Ghost button', targets: ['button'], base: { color: 'primary', background: 'transparent' } },
      { id: 'pale-button', name: 'Pale button', targets: ['button'], base: { color: '#ffffff', weight: 600 } },
      { id: 'lead', name: 'Lead', targets: ['text'], base: { size: '1.25rem' } },
    ];
    const check = (part_styles: Record<string, string>, data: Record<string, unknown> = {}) => partStyleIssues({ id: 'h', type: 'core/hero', data: { part_styles, ...data } }, type, styles, { contrast: { colors, renderVersion: LATEST_RENDER_VERSION } });
    expect(check({ primary_button: 'ghost-buton' }).errors[0]).toEqual(expect.objectContaining({ code: 'unknown_style', suggestions: ['ghost-button'] }));
    expect(check({ primary_button: 'lead' }).errors[0]).toEqual(expect.objectContaining({ code: 'style_target_mismatch', suggestions: ['ghost-button', 'pale-button'] }));
    expect(check({ primary_button: 'ghost-button' })).toEqual({ errors: [], warnings: [] });
    // White text on the primary button background is readable; on the white page it is not.
    expect(check({ primary_button: 'pale-button' }).errors).toEqual([]);
    expect(check({ secondary_button: 'pale-button' }).errors[0]).toEqual(expect.objectContaining({ code: 'part_style_contrast', path: 'data.part_styles.secondary_button' }));
    // The instance background field is the background of the text parts.
    const dark: SiteStyle = { id: 'pale-text', name: 'Pale text', targets: ['text'], base: { color: '#eeeeee' } };
    const textCheck = (background?: string) => partStyleIssues({ type: 'core/hero', data: { part_styles: { eyebrow: 'pale-text' }, background } }, type, [dark], { contrast: { colors } });
    expect(textCheck().errors).toHaveLength(1);
    expect(textCheck('#111111').errors).toEqual([]);
    expect(treePartStyleIssues([{ id: 'h', type: 'core/hero', data: { part_styles: { eyebrow: 'nope' } } }], registry, styles)[0]?.path).toBe('blocks[0].data.part_styles.eyebrow');
  });
});

describe('styles that target parts', () => {
  it('validates the reference format and one site-wide style per part', () => {
    expect(validateSiteStyle({ ...quietLink, parts: ['core/rich_heading.link'] }).style?.parts).toEqual(['core/rich_heading.link']);
    expect(validateSiteStyle({ ...quietLink, parts: ['rich heading'] }).errors[0]).toContain('is not a block part');
    expect(validateSiteStyle({ id: 'link', name: 'Link', role: 'link', targets: [], base: {}, parts: ['core/rich_heading.link'] }).errors[0]).toContain('element role');
    expect(siteStyleLibraryErrors([{ ...quietLink, parts: ['core/rich_heading.link'] }, { ...loudLink, parts: ['core/rich_heading.link'] }])[0]).toContain('core/rich_heading.link');
  });

  it('names unknown parts and missing targets against the registry', () => {
    expect(stylePartErrors({ ...quietLink, parts: ['core/rich_heading.lnk'] }, registry)[0]).toContain('Did you mean core/rich_heading.link?');
    expect(stylePartErrors({ ...quietLink, parts: ['core/hero.heading'] }, registry)[0]).toContain('Add "heading" to its targets');
    expect(stylePartErrors({ ...quietLink, parts: ['core/rich_heading.link'] }, registry)).toEqual([]);
  });

  it('measures contrast on the part background', () => {
    const style: SiteStyle = { id: 'dark-label', name: 'Dark label', targets: ['button'], base: { color: 'text' }, parts: ['core/hero.primary_button'] };
    const surfaces = stylePartSurfaces(style, registry);
    expect(surfaces).toEqual([{ label: 'core/hero.primary_button', use: 'content', color: 'on_primary', background: 'primary' }]);
    const onPrimary = styleContrastReport(style, { ...colors, primary: '#111111' }, { surfaces });
    expect(onPrimary.errors[0]).toContain('base on core/hero.primary_button');
    // Without the part it is measured on the site background only.
    expect(styleContrastReport(style, { ...colors, primary: '#111111' }).errors).toEqual([]);
  });
});

describe('site block types with parts', () => {
  const resolveType = (id: string) => registry.get(id);
  const definition = {
    name: 'promo', label: 'Promo', template: '<div data-block="promo"><p class="promo-label">{{label}}</p></div>',
    schema: [{ name: 'label', type: 'text', label: 'Label' }],
    parts: [{ name: 'label', label: 'Label', selector: '.promo-label', target: 'text' }],
  };

  it('stores parts and adds the part_styles field', () => {
    const { value, problems } = validateBlockTypeDefinition(definition, { resolveType });
    expect(problems).toEqual([]);
    expect(value.parts).toEqual(definition.parts);
    expect(value.schema?.map(field => field.name)).toEqual(['label', 'part_styles']);
    // Reading the type back and writing it again keeps one field.
    const again = validateBlockTypeDefinition({ ...definition, schema: value.schema }, { resolveType });
    expect(again.value.schema?.map(field => field.name)).toEqual(['label', 'part_styles']);
    // Removing the parts removes the field.
    const existing = { ...again.merged, id: 'promo' } as BlockType;
    expect(validateBlockTypeDefinition({ parts: [] }, { resolveType, partial: true, existing }).value.schema?.map(field => field.name)).toEqual(['label']);
  });

  it('rejects unsafe selectors and warns about a class the template never writes', () => {
    const bad = validateBlockTypeDefinition({ ...definition, parts: [{ ...definition.parts[0], selector: '.x{color:red}' }] }, { resolveType });
    expect(bad.problems).toEqual([expect.objectContaining({ severity: 'error', path: '/parts/0/selector' })]);
    const missing = validateBlockTypeDefinition({ ...definition, parts: [{ ...definition.parts[0], selector: '.promo-title' }] }, { resolveType });
    expect(missing.problems).toEqual([expect.objectContaining({ severity: 'warning', path: '/parts/0/selector' })]);
    const field = validateBlockTypeDefinition({ ...definition, parts: [{ ...definition.parts[0], style_field: 'label' }] }, { resolveType });
    expect(field.problems[0]).toEqual(expect.objectContaining({ path: '/parts/0/style_field' }));
  });

  it('renders the instance attribute for a site block type', () => {
    const { merged } = validateBlockTypeDefinition(definition, { resolveType });
    const local = new Map(registry);
    local.set('promo', { ...merged, id: 'promo' });
    const html = renderBlocks([{ id: 'p', type: 'promo', data: { label: 'New', part_styles: { label: 'lead' } } }], { registry: local });
    expect(html).toContain('data-part-label="lead"');
  });
});
