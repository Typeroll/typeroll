// Render version 16 settings and hooks of the tier 1 blocks (tier1-blocks.ts):
// each setting renders at 16 and leaves version 15 output as it was.
import { describe, expect, it } from 'vitest';
import { blockOutputForVersion, blockPartsAt, buildCoreBlockRegistry, collectBlockAssets, renderBlocks } from '../index.js';
import type { Block } from '../types.js';

const registry = buildCoreBlockRegistry();
const html = (type: string, data: Record<string, unknown>, renderVersion = 16) =>
  renderBlocks([{ id: 'b', type, data }], { registry, renderVersion });
const css = (type: string, renderVersion = 16) => blockOutputForVersion(registry.get(type)!, renderVersion).styles;
const openingTag = (markup: string) => markup.match(/^<[a-z]+[^>]*>/)![0];

const TIER1_TYPES = ['core/container', 'core/grid', 'core/icon', 'core/icon_box', 'core/hero', 'core/cta', 'core/testimonial', 'core/team_member',
  'core/pricing_plan', 'core/logo_item', 'core/step_card', 'core/navigation', 'core/accordion', 'core/video', 'core/media_card', 'core/feature_row', 'core/search'];

describe('tier 1 blocks at render version 16', () => {
  it('write no !important in their styles from version 16', () => {
    for (const type of TIER1_TYPES) expect(css(type).replace(/\/\*[\s\S]*?\*\//g, ''), type).not.toContain('!important');
    expect(css('core/grid', 15)).toContain('--cols: 1 !important');
    expect(css('core/hero', 15)).toContain('order: 2 !important');
  });

  it('stack a grid at its stack_at width through a variable that is never inline', () => {
    expect(css('core/grid')).toContain('{ --stack-cols: 1; grid-template-columns: minmax(0, 1fr); }');
    expect(css('core/grid')).toContain('repeat(var(--stack-cols, var(--cols, 3)), minmax(0, 1fr))');
  });

  it('hero: heading level, image alt, stacked order, image size, gap and text colour', () => {
    const hero = html('core/hero', { heading: 'Hi', image: '/a.jpg', image_alt: 'A roof', heading_level: 'h2', stack_order: 'image-first', image_max: 'sm', gap: 'lg', text_color: '#123456' });
    expect(hero).toContain('<h2 class="block-hero-heading">Hi</h2>');
    expect(hero).toContain('alt="A roof"');
    expect(openingTag(hero)).toContain('data-stack-order="image-first"');
    expect(openingTag(hero)).toContain('data-image-max="sm"');
    expect(openingTag(hero)).toContain('data-gap="lg"');
    expect(openingTag(hero)).toContain('data-text-color="#123456"');
    expect(openingTag(hero)).toContain('--text-color:#123456');
    // Defaults: h1, text above the image on phones, as before.
    const plain = html('core/hero', { heading: 'Hi' });
    expect(plain).toContain('<h1 class="block-hero-heading">Hi</h1>');
    expect(openingTag(plain)).toContain('data-stack-order="text-first"');
    expect(css('core/hero')).toContain('[data-block="hero"][data-stack-order="text-first"] .block-hero-media { order: 2; }');
    expect(css('core/hero')).toContain('[data-block="hero"][data-gap="lg"] { --hero-gap: 2.5rem; }');
    const old = html('core/hero', { heading: 'Hi', image: '/a.jpg', image_alt: 'A roof', heading_level: 'h2', text_color: '#123456' }, 15);
    expect(old).toContain('<h1 class="block-hero-heading">Hi</h1>');
    expect(old).toContain('alt=""');
    expect(old).not.toContain('data-stack-order');
    expect(old).not.toContain('--text-color');
  });

  it('cta: heading level, text colour, background focal point and an image beside the text', () => {
    const cta = html('core/cta', { heading: 'Go', heading_level: 'h3', text_color: '#222222', background_image: '/b.jpg', image_alt: 'Team', image_position: 'right', background_focal_x: 20 });
    expect(cta).toContain('<h3 class="block-cta-heading">Go</h3>');
    expect(cta).toContain('<div class="block-cta-media"><img src="/b.jpg" alt="Team" loading="lazy" decoding="async" /></div>');
    expect(openingTag(cta)).toContain('data-text-color="#222222"');
    expect(openingTag(cta)).toContain('--background_focal_x:20');
    expect(css('core/cta')).toContain('background-position: calc(var(--background_focal_x, 50) * 1%) calc(var(--background_focal_y, 50) * 1%)');
    expect(css('core/cta')).toContain('[data-block="cta"]:is([data-image-pos="left"], [data-image-pos="right"]) > .block-cta-media { display:block;');
    expect(html('core/cta', { heading: 'Go' })).not.toContain('block-cta-media');
    const old = html('core/cta', { heading: 'Go', heading_level: 'h3', background_image: '/b.jpg', image_position: 'right' }, 15);
    expect(old).toContain('<h2 class="block-cta-heading">Go</h2>');
    expect(old).not.toContain('block-cta-media');
    expect(old).not.toContain('--background_focal_x');
  });

  it('media_card: eyebrow, second button, button alignment, vertical alignment, stacked order, gap and padding', () => {
    const card = html('core/media_card', { image: '/c.jpg', eyebrow: 'New', heading: 'H', button_label: 'Start', button_url: '/s/', secondary_label: 'More', secondary_url: '/m/',
      actions_align: 'center', vertical_align: 'top', stack_order: 'text-first', gap: 'sm', padding_px: 24 });
    expect(card).toContain('<span class="block-mediacard-eyebrow">New</span>');
    expect(card).toContain('<a class="block-btn block-btn-secondary block-mediacard-secondary" href="/m/">More</a>');
    expect(card).toContain('<div class="block-mediacard-actions">');
    for (const attr of ['data-actions-align="center"', 'data-vertical-align="top"', 'data-stack-order="text-first"', 'data-gap="sm"', '--padding_px:24px']) expect(openingTag(card)).toContain(attr);
    expect(css('core/media_card')).toContain('padding: var(--padding_px, 0);');
    const old = html('core/media_card', { image: '/c.jpg', eyebrow: 'New', secondary_label: 'More', padding_px: 24 }, 15);
    expect(old).not.toContain('block-mediacard-eyebrow');
    expect(old).not.toContain('block-mediacard-secondary');
    expect(old).not.toContain('padding_px');
  });

  it('feature_row: text and button alignment, image aspect and fit, text colour and bottom alignment', () => {
    const row = openingTag(html('core/feature_row', { image: '/f.jpg', text_align: 'center', actions_align: 'end', image_aspect: 'square', image_fit: 'contain', text_color: '#333333', vertical_align: 'end' }));
    for (const attr of ['data-text-align="center"', 'data-actions-align="end"', 'data-image-aspect="square"', 'data-image-fit="contain"', 'data-text-color="#333333"', 'data-valign="end"']) expect(row).toContain(attr);
    // The text colour stays out of the end of the style, which `[style$="--bg:"]` rules read.
    expect(row).toMatch(/style="--text-color:#333333;--gap:/);
    expect(css('core/feature_row')).toContain('[data-block="feature_row"][data-valign="end"] .block-frow-inner { align-items: end; }');
    expect(openingTag(html('core/feature_row', { image: '/f.jpg', text_align: 'center' }, 15))).not.toContain('data-text-align');
  });

  it('logo_item: a logo height', () => {
    expect(openingTag(html('core/logo_item', { src: '/l.svg', height_px: 40 }))).toContain('data-height-px="40px"');
    expect(css('core/logo_item')).toContain('[data-block="logo_item"][data-height-px] img { height:var(--height_px);');
    expect(html('core/logo_item', { src: '/l.svg', height_px: 40 }, 15)).not.toContain('height_px');
  });

  it('navigation: collapse width, menu symbol size, link gap and link colour', () => {
    const nav = openingTag(html('core/navigation', { links: [{ label: 'A', href: '/a' }], collapse_below: '768', toggle_size_px: 28, gap_px: 32, color: '#111111' }));
    for (const attr of ['data-collapse-below="768"', 'data-color="#111111"', '--link-color:#111111', '--toggle_size_px:28px', '--gap_px:32px']) expect(nav).toContain(attr);
    expect(openingTag(html('core/navigation', { links: [] }))).toContain('data-collapse-below="1024"');
    expect(css('core/navigation')).toContain('@media (max-width: 767px) {\n  [data-block="navigation"][data-collapse-below="768"] .block-navigation-list');
    const { script } = blockOutputForVersion(registry.get('core/navigation')!, 16);
    expect(script).toContain('el.dataset.collapseBelow');
    expect(blockOutputForVersion(registry.get('core/navigation')!, 15).script).toContain("(max-width: 1023px)");
    expect(openingTag(html('core/navigation', { links: [], collapse_below: '768', color: '#111111' }, 15))).toBe('<nav data-block="navigation" aria-label="Main navigation" data-block-type="core/navigation">');
  });

  it('icon: a circle or square surface with its own background', () => {
    const tag = openingTag(html('core/icon', { icon: 'star', icon_style: 'circle-bg', background: '#eeeeee' }));
    expect(tag).toContain('data-icon-style="circle-bg"');
    expect(tag).toContain('data-background="#eeeeee"');
    expect(css('core/icon')).toContain('[data-block="icon"][data-background]:not([data-background=""]) { --icon-surface:var(--icon-background); }');
    expect(openingTag(html('core/icon', { icon: 'star', icon_style: 'circle-bg' }, 15))).not.toContain('icon-style');
  });

  it('container: icon pairing can be turned off, and a text colour', () => {
    const tag = openingTag(html('core/container', { icon_pairing: 'off', text_color: '#ffffff' }));
    expect(tag).toContain('data-icon-pairing="off"');
    expect(tag).toContain('data-text-color="#ffffff"');
    expect(css('core/container')).toContain('[data-block="container"][data-column-only="true"][data-icon-pairing="off"]:has(> [data-block="icon"] + *) { display:flex;');
    expect(openingTag(html('core/container', { icon_pairing: 'off', text_color: '#ffffff' }, 15))).not.toMatch(/icon-pairing|text-color/);
  });

  it('icon_box: vertical alignment beside the text', () => {
    expect(openingTag(html('core/icon_box', { icon: 'star', layout: 'icon-left', vertical_align: 'center' }))).toContain('data-vertical-align="center"');
    expect(openingTag(html('core/icon_box', { icon: 'star', vertical_align: 'center' }, 15))).not.toContain('data-vertical-align');
  });

  it('step_card, team_member and pricing_plan: heading level and their new settings', () => {
    const step = html('core/step_card', { title: 'T', heading_level: 'h4', layout: 'icon-left', align: 'center', icon_size_px: 32 });
    expect(step).toContain('<h4 class="block-step-title">T</h4>');
    for (const attr of ['data-layout="icon-left"', 'data-align="center"', '--icon_size_px:32px']) expect(openingTag(step)).toContain(attr);
    const team = html('core/team_member', { name: 'Ada', heading_level: 'h2', photo_aspect: 'portrait', align: 'left', radius: 'full' });
    expect(team).toContain('<h2 class="block-team-name">Ada</h2>');
    for (const attr of ['data-photo-aspect="portrait"', 'data-align="left"', 'data-radius="full"']) expect(openingTag(team)).toContain(attr);
    const plan = html('core/pricing_plan', { name: 'Pro', heading_level: 'h4', background: '#fafafa' });
    expect(plan).toContain('<h4 class="block-pricing-name">Pro</h4>');
    expect(openingTag(plan)).toContain('data-background="#fafafa"');
    expect(css('core/pricing_plan')).toContain('border: 1px solid var(--pricing-border, rgba(0,0,0,0.1));');
    expect(html('core/step_card', { title: 'T', heading_level: 'h4' }, 15)).toContain('<h3 class="block-step-title">');
    expect(html('core/team_member', { name: 'Ada', heading_level: 'h2' }, 15)).toContain('<h3 class="block-team-name">');
    expect(html('core/pricing_plan', { name: 'Pro', heading_level: 'h4' }, 15)).toContain('<h3 class="block-pricing-name">');
  });

  it('testimonial: alignment, avatar size and card background', () => {
    const tag = openingTag(html('core/testimonial', { quote: '<p>Q</p>', align: 'center', avatar_size_px: 64, background: '#f0f0f0' }));
    for (const attr of ['data-align="center"', 'data-background="#f0f0f0"', '--avatar_size_px:64px']) expect(tag).toContain(attr);
    expect(openingTag(html('core/testimonial', { quote: '<p>Q</p>', align: 'center' }, 15))).toBe('<figure data-block="testimonial" data-style="card">');
  });

  it('video: width, alignment, corner radius and a caption below the player', () => {
    const player = html('core/video', { source: 'url', video_url: '/v.mp4', caption: 'Our workshop', width: 'narrow', align: 'left', radius: 'none' });
    expect(player).toContain('<div class="block-video-frame"><video ');
    expect(player).toContain('<p class="block-video-caption">Our workshop</p>');
    for (const attr of ['data-width="narrow"', 'data-align="left"', 'data-radius="none"', 'data-aspect-ratio="16:9"']) expect(openingTag(player)).toContain(attr);
    expect(css('core/video')).toContain('[data-block="video"][data-aspect-ratio="16:9"] > .block-video-frame { aspect-ratio: 16/9; }');
    expect(html('core/video', { source: 'url', video_url: '/v.mp4' })).not.toContain('block-video-caption');
    expect(html('core/video', { source: 'url', video_url: '/v.mp4', caption: 'Our workshop' }, 15)).not.toMatch(/block-video-(frame|caption)/);
  });

  it('search: maximum width and alignment', () => {
    const tag = openingTag(html('core/search', { max_width_px: 720, align: 'left' }));
    expect(tag).toContain('--max_width_px:720px');
    expect(tag).toContain('data-align="left"');
    expect(css('core/search')).toContain('[data-block="search"] { max-width: var(--max_width_px, 40rem);');
  });

  it('accordion and table of contents: classes for site CSS, and an accordion border variable', () => {
    const faq = html('core/accordion', { items: [{ title: 'Q', content: '<p>A</p>' }] });
    expect(faq).toContain('<details class="block-accordion-item"><summary class="block-accordion-title">Q</summary><div class="block-accordion-panel"><p>A</p></div></details>');
    expect(css('core/accordion')).toContain('border: 1px solid var(--accordion-border, rgba(0,0,0,0.1));');
    expect(html('core/accordion', { items: [{ title: 'Q', content: '<p>A</p>' }] }, 15)).toContain('<details><summary>Q</summary>');
    const toc = renderBlocks([{ id: 't', type: 'core/table_of_contents', data: {} }], { registry, renderVersion: 16, context: { page: { body: '<h2>One</h2>' } } });
    expect(toc).toContain('<strong class="block-toc-title">');
    expect(toc).toContain('<ol class="block-toc-list">');
  });

  it('name the new parts, and those that only exist at 16 are absent before', () => {
    const parts = (type: string, version: number) => blockPartsAt(registry.get(type)!, version).map(part => part.name);
    expect(parts('core/hero', 16)).toEqual(expect.arrayContaining(['body', 'media_column']));
    expect(parts('core/cta', 16)).toEqual(expect.arrayContaining(['inner', 'media']));
    expect(parts('core/cta', 15)).not.toContain('media');
    expect(parts('core/media_card', 16)).toEqual(expect.arrayContaining(['media_column', 'eyebrow', 'secondary_button', 'actions']));
    expect(parts('core/media_card', 15)).not.toContain('eyebrow');
    expect(parts('core/feature_row', 16)).toContain('body');
    expect(parts('core/icon_box', 16)).toContain('body');
    expect(parts('core/pricing_plan', 16)).toContain('amount');
    expect(parts('core/post_card', 16)).toEqual(expect.arrayContaining(['media', 'body', 'date', 'author', 'actions']));
    expect(parts('core/icon', 16)).toContain('link');
    expect(parts('core/video', 16)).toContain('caption');
    expect(parts('core/video', 15)).not.toContain('caption');
  });

  it('keep the default look: new settings default to what version 16 rendered before', () => {
    // Defaults produce no colour, alignment or size rules, only the attributes of their default values.
    const blocks: Block[] = TIER1_TYPES.map(type => ({ id: type.replace('/', '-'), type, data: {} }));
    const assets = collectBlockAssets(blocks, registry, { renderVersion: 16 }).css;
    expect(assets).toContain('[data-block="hero"][data-text-color]:not([data-text-color=""])');
    const markup = renderBlocks(blocks, { registry, renderVersion: 16 });
    expect(markup).not.toMatch(/data-(?:text-color|background|color)="[^"]+"/);
  });

  it('core/form declares its version 16 presentation settings', () => {
    const fields = Object.fromEntries(registry.get('core/form')!.schema.map(field => [field.name, field]));
    for (const name of ['max_width_px', 'align', 'submit_align', 'submit_width']) expect(fields[name]?.min_render_version, name).toBe(16);
    expect(fields.max_width_px).toMatchObject({ type: 'number', css_unit: 'px', min: 240, max: 2400 });
    expect(fields.submit_width?.options).toEqual(['auto', 'full']);
  });
});
