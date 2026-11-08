/**
 * Render version 16 block settings and CSS hooks: core text blocks, button,
 * list, story blocks, repeater grids and template blocks. Each new setting
 * renders at 16 and leaves older versions as they were.
 */
import { describe, expect, it } from 'vitest';
import { buildCoreBlockRegistry } from '../core-blocks.js';
import { collectBlockAssets, renderBlocks } from '../render-blocks.js';
import { blockPartsAt } from '../block-parts.js';
import type { Block } from '../types.js';

const registry = buildCoreBlockRegistry();
const render = (block: Block, renderVersion = 16, context?: Record<string, unknown>) =>
  renderBlocks([block], { registry, renderVersion, context: context as never });
const css = (block: Block, renderVersion = 16) => collectBlockAssets([block], registry, { renderVersion }).css;
const block = (type: string, data: Record<string, unknown> = {}, extra: Partial<Block> = {}): Block => ({ id: 'b1', type, data, ...extra });
const partNames = (type: string, version: number) => blockPartsAt(registry.get(type)!, version).map(part => part.name);

describe('render version 16: colours and alignment leave the inline style', () => {
  it('writes the text line colour as a custom property applied only when set', () => {
    const coloured = block('core/text', { text: 'Hi', color: '#123456' });
    expect(render(coloured)).toContain('data-color style="--text-color:#123456"');
    expect(render(coloured)).not.toContain('style="color:');
    expect(css(coloured)).toContain('[data-block="text"][data-color] { color:var(--text-color); }');
    expect(render(block('core/text', { text: 'Hi' }))).not.toContain('data-color');
    expect(render(coloured, 15)).toContain('style="color:#123456"');
  });

  it('writes the prose colour as a custom property applied only when set', () => {
    const coloured = block('core/prose', { html: '<p>Hi</p>', color: '#123456' });
    expect(render(coloured)).toContain('--prose-color:#123456');
    expect(render(coloured)).toContain(' data-color ');
    expect(render(coloured)).not.toContain(';color:#123456');
    expect(css(coloured)).toContain('[data-block="prose"][data-color] { color:var(--prose-color); }');
    expect(render(coloured, 15)).toContain(';color:#123456');
  });

  it('moves a narrow or wide prose box to an explicit start or end, and keeps the default centred', () => {
    const start = block('core/prose', { html: '<p>Hi</p>', max_width: 'narrow', text_align: 'start' });
    expect(render(start)).toContain('data-text-align="start"');
    const styles = css(start);
    expect(styles).toContain('[data-block="prose"]:is([data-w="narrow"],[data-w="wide"])[data-text-align="start"] { margin-inline:0 auto; }');
    expect(styles).toContain('[data-block="prose"][data-w="narrow"] { max-width: 38rem; margin-inline: auto; }');
    expect(render(block('core/prose', { html: '<p>Hi</p>', max_width: 'narrow' }))).toContain('data-text-align="inherit"');
    expect(render(start, 15)).not.toContain('data-text-align');
  });

  it('applies the heading alignment from --align in CSS instead of an inline text-align', () => {
    const heading = block('core/heading', { text: 'Title', level: 'h2', align: 'center' });
    expect(render(heading)).toContain('style="--align:center;"');
    expect(render(heading)).not.toContain('text-align:var(--align,left)');
    expect(css(heading)).toContain('[data-block="heading"][data-level] { text-align:var(--align,left); }');
    expect(render(heading, 15)).toContain('text-align:var(--align,left)');
  });
});

describe('render version 16: core/columns', () => {
  it('stacks without !important and can stay side by side', () => {
    const columns = block('core/columns', { stack_below: 'never' }, { slots: [[], []] });
    expect(render(columns)).toContain('data-stack-below="never"');
    const v16 = css(columns);
    expect(v16).toMatch(/\[data-block="columns"\]\[data-stack-below="721"\] \{ grid-template-columns:minmax\(0,1fr\); \}/);
    expect(v16).not.toContain('[data-stack-below="never"]');
    expect(css(columns, 15)).toContain('grid-template-columns:minmax(0,1fr) !important');
  });
});

describe('render version 16: core/button', () => {
  it('aligns, fills the width and shows an icon after the label', () => {
    const button = block('core/button', { label: 'Go', href: '/go/', align: 'center', full_width: true, icon: 'arrow-right', icon_size_px: 20 });
    const html = render(button);
    expect(html).toContain('data-align="center"');
    expect(html).toContain('data-full-width="true"');
    expect(html).toMatch(/Go<span class="block-button-icon" aria-hidden="true"><svg[^>]*>.*<\/svg><\/span><\/a>/s);
    expect(html).toContain('--icon_size_px:20px');
    const styles = css(button);
    expect(styles).toContain('[data-block="button"][data-align="center"] { text-align:center; }');
    expect(styles).toContain('[data-block="button"][data-full-width="true"] .block-button-link { display:block; box-sizing:border-box; inline-size:100%; }');
    expect(styles).toContain('font-size:var(--icon_size_px, 1em)');
  });

  it('keeps the default button markup apart from its setting attributes, and older versions unchanged', () => {
    const plain = block('core/button', { label: 'Go', href: '/go/' });
    expect(render(plain)).not.toContain('block-button-icon');
    expect(render(plain)).toContain('data-align="inherit"');
    const old = render(block('core/button', { label: 'Go', href: '/go/', align: 'center', full_width: true, icon: 'arrow-right', icon_size_px: 20 }), 15);
    expect(old).not.toMatch(/data-align|data-full-width|block-button-icon|--icon_size_px/);
  });
});

describe('render version 16: core/list', () => {
  const items = [{ html: 'One' }, { html: 'Two' }, { html: 'Three' }];
  it('sets the item gap, two columns and the text size', () => {
    const list = block('core/list', { items, gap_px: 16, layout: 'two-column', font_size_px: 20 });
    const html = render(list);
    expect(html).toContain('--gap_px:16px');
    expect(html).toContain('--font_size_px:20px');
    expect(html).toContain('data-layout="two-column"');
    expect(html).toContain('data-font-size-px="20px"');
    const styles = css(list);
    expect(styles).toContain('[data-block="list"] li{margin-block:var(--gap_px,.35rem)}');
    expect(styles).toContain('[data-block="list"][data-layout="two-column"] :is(ul,ol){columns:2 14rem;column-gap:2.5rem}');
    expect(styles).toContain('[data-block="list"][data-font-size-px]{font-size:var(--font_size_px)}');
    expect(render(list, 15)).not.toMatch(/--gap_px|--font_size_px|data-layout/);
  });
});

describe('render version 16: story blocks', () => {
  it('colours the key figures only when a colour is set', () => {
    const stats = block('core/stats', { items: [{ value: '12', label: 'A' }], value_color: '#123456' });
    expect(render(stats)).toContain('data-value-color style="--cols:4;--stats-value-color:#123456"');
    expect(css(stats)).toContain('[data-block="stats"][data-value-color] .block-stats-value { color:var(--stats-value-color); }');
    expect(render(block('core/stats', { items: [{ value: '12', label: 'A' }] }))).not.toContain('data-value-color');
    expect(render(stats, 15)).not.toContain('stats-value-color');
  });

  it('sets the heading level of timeline and scroll step items, h3 by default', () => {
    const timeline = block('core/timeline', { items: [{ title: 'Founded' }], heading_level: 'h4' });
    expect(render(timeline)).toContain('<h4 class="block-timeline-title">Founded</h4>');
    expect(render(block('core/timeline', { items: [{ title: 'Founded' }] }))).toContain('<h3 class="block-timeline-title">Founded</h3>');
    expect(render(timeline, 15)).toContain('<h3 class="block-timeline-title">Founded</h3>');
    const steps = block('core/scroll_steps', { items: [{ title: 'One' }], heading_level: 'h2' });
    expect(render(steps)).toContain('<h2 class="block-steps-title">One</h2>');
    expect(render(steps, 15)).toContain('<h3 class="block-steps-title">One</h3>');
  });

  it('places, sizes and aligns the audio cover and drops the card', () => {
    const audio = block('core/audio', { src: '/a.mp3', cover: '/c.jpg', cover_align: 'center', cover_size: 'lg', cover_position: 'top', appearance: 'plain' });
    const html = render(audio);
    for (const attr of ['data-cover-align="center"', 'data-cover-size="lg"', 'data-cover-position="top"', 'data-appearance="plain"']) expect(html).toContain(attr);
    const styles = css(audio);
    expect(styles).toContain('[data-block="audio"][data-cover-position="top"] { grid-template-columns:1fr; }');
    expect(styles).toContain('[data-block="audio"][data-appearance="plain"] { padding:0; border-radius:0; background:none; }');
    expect(render(audio, 15)).not.toContain('data-cover-align');
  });

  it('gives the before and after comparison a width and an alignment', () => {
    const compare = block('core/before_after', { before_image: '/b.jpg', after_image: '/a.jpg', width: 'narrow', align: 'left' });
    expect(render(compare)).toContain('data-width="narrow"');
    expect(render(compare)).toContain('data-align="left"');
    expect(css(compare)).toContain('[data-block="before_after"][data-width="narrow"] { max-inline-size:32rem; }');
    expect(render(compare, 15)).not.toContain('data-width');
  });

  it('colours the announcement bar only when colours are set', () => {
    const bar = block('core/announcement_bar', { text: '<p>Open</p>', background: '#123456', text_color: '#ffffff' });
    expect(render(bar)).toContain('data-background data-text-color style="--announcement-bg:#123456;--announcement-fg:#ffffff;"');
    const styles = css(bar);
    expect(styles).toContain('[data-block="announcement_bar"][data-background] { background:var(--announcement-bg); }');
    expect(styles).toContain('[data-block="announcement_bar"][data-text-color] { color:var(--announcement-fg); }');
    expect(render(block('core/announcement_bar', { text: '<p>Open</p>' }))).not.toMatch(/data-background|--announcement-bg/);
    expect(render(bar, 15)).not.toContain('--announcement-bg');
  });

  it('names the new parts from version 16 only', () => {
    const added: Record<string, string[]> = {
      'core/timeline': ['item', 'image'],
      'core/before_after': ['before', 'after', 'handle'],
      'core/announcement_bar': ['inner', 'close'],
      'core/scroll_steps': ['step'],
      'core/svg_animation': ['toggle'],
      'core/audio': ['body', 'player', 'transcript'],
      'core/section': ['inner'],
    };
    for (const [type, names] of Object.entries(added)) {
      expect(partNames(type, 16), type).toEqual(expect.arrayContaining(names));
      for (const name of names) expect(partNames(type, 15), type).not.toContain(name);
    }
  });
});

describe('render version 16: repeater grids', () => {
  const cards = (extra: Record<string, unknown> = {}) => block('core/feature_grid', { items: [1, 2, 3, 4].map(n => ({ heading: `F${n}` })), ...extra });

  it('centres a short last row when asked, and marks the choice on the grid', () => {
    expect(render(cards({ last_row: 'center' }))).toContain('data-last-row="center"');
    expect(render(cards())).not.toContain('data-last-row');
    expect(render(cards({ last_row: 'center' }), 15)).not.toContain('data-last-row');
    const styles = css(cards({ last_row: 'center' }));
    expect(styles).toContain('[data-block="repeater"][data-layout="grid"][data-last-row="center"] { display:flex; flex-wrap:wrap; justify-content:center; }');
  });

  it('lets a logo grid opt back to a start-aligned last row and set the logo height', () => {
    const logos = block('core/logo_cloud', { items: [{ src: '/l.svg', alt: 'L' }], last_row: 'start', logo_height_px: 48 });
    const html = render(logos);
    expect(html).toContain('data-last-row="start"');
    expect(html).toContain('--logo_height_px:48px');
    expect(css(logos)).toContain('[data-block="repeater"] { --logo-height:var(--logo_height_px); }');
    expect(render(logos, 15)).not.toMatch(/data-last-row|--logo_height_px/);
  });
});

describe('render version 16: template blocks', () => {
  const page = { title: 'About', excerpt: 'Who we are', og_image: '/hero.jpg' };
  const site = { name: 'Acme', tagline: 'Since 1900' };

  it('marks each template block with its own data-template-block name', () => {
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ['template/page_title', {}, 'page_title'],
      ['template/page_featured_image', {}, 'page_featured_image'],
      ['template/page_excerpt', {}, 'page_excerpt'],
      ['template/site_title', {}, 'site_title'],
      ['template/site_tagline', {}, 'site_tagline'],
    ];
    for (const [type, data, name] of cases) {
      expect(render(block(type, data), 16, { page, site }), type).toContain(`data-template-block="${name}"`);
      expect(render(block(type, data), 15, { page, site }), type).not.toContain('data-template-block=');
    }
  });

  it('applies the page title alignment from CSS', () => {
    const title = block('template/page_title', { align: 'center' });
    expect(render(title, 16, { page })).not.toContain('text-align:var(--align,left)');
    expect(css(title)).toContain('[data-block="heading"][data-level] { text-align:var(--align,left); }');
    expect(render(title, 15, { page })).toContain('text-align:var(--align,left)');
  });

  it('aligns the site title and links it to the home page', () => {
    const title = block('template/site_title', { align: 'center', link_to_home: true });
    const html = render(title, 16, { site });
    expect(html).toContain('data-align="center"');
    expect(html).toContain('<a class="block-site-title-link" href="/">Acme</a>');
    expect(css(title)).toContain('[data-template-block="site_title"][data-align="center"] { text-align:center; }');
    expect(render(block('template/site_title'), 16, { site })).not.toContain('<a ');
  });

  it('sizes, aligns and colours the excerpt and tagline', () => {
    for (const type of ['template/page_excerpt', 'template/site_tagline']) {
      const html = render(block(type, { font_size_px: 20, text_align: 'center', color: '#123456' }), 16, { page, site });
      expect(html, type).toContain('--font_size_px:20px');
      expect(html, type).toContain('--text_align:center');
      expect(html, type).toContain('data-text-align="center"');
      expect(html, type).toContain('--prose-color:#123456');
      expect(render(block(type, { font_size_px: 20 }), 15, { page, site }), type).not.toContain('--font_size_px');
    }
  });

  it('scopes the featured image rules to the featured image and adds alignment, radius and focal point', () => {
    const image = block('template/page_featured_image', { align: 'left', radius: 'lg', focal_x: 20, focal_y: 80 });
    const html = render(image, 16, { page });
    expect(html).toContain('data-align="left"');
    expect(html).toContain('data-radius="lg"');
    expect(html).toContain('--focal_x:20');
    const styles = css(image);
    expect(styles).not.toMatch(/\[data-block="image"\] img \{ display:block/);
    expect(styles).toContain('[data-template-block="page_featured_image"] img { display:block; width:100%; height:auto; object-fit:contain; }');
    expect(styles).toContain('[data-template-block="page_featured_image"][data-radius="lg"] img { border-radius:1.25rem; }');
    expect(css(image, 15)).toContain('[data-block="image"] img { display:block;');
  });

  it('gives the page navigation labels and titles classes', () => {
    const nav = block('template/page_navigation', {});
    const context = { page: { previous: { url: '/a/', title: 'A' }, next: { url: '/b/', title: 'B' } } };
    expect(render(nav, 16, context)).toContain('<small class="page-navigation-label">');
    expect(render(nav, 16, context)).toContain('<span class="page-navigation-title">');
    expect(render(nav, 15, context)).not.toContain('page-navigation-label');
  });

  it('keeps a small site logo legible from version 16', () => {
    const logo = block('template/site_logo', { height: 'sm' });
    expect(css(logo)).toContain('[data-block="site-logo"][data-size="sm"] img { height: 2rem; }');
    expect(css(logo, 15)).toContain('[data-block="site-logo"][data-size="sm"] img { height: 1.5rem; }');
  });
});
