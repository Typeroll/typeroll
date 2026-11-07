import { describe, expect, it } from 'vitest';
import { buildCoreBlockRegistry, collectBlockAssets, renderBlocks, type Block } from '../index.js';

const registry = buildCoreBlockRegistry();
const render = (blocks: Block[], renderVersion = 14, site: Record<string, unknown> = {}) =>
  renderBlocks(blocks, { registry, renderVersion, context: { site: { language: 'sv', ...site }, page: { language: 'sv' } } as never });
const text: Block = { id: 't', type: 'core/text', data: { content: '<p>Hej</p>' } };

describe('entrance motion', () => {
  it('marks a block from version 14 and leaves older versions unchanged', () => {
    const section: Block = { id: 's', type: 'core/section', data: { motion: 'rise' }, children: [text] };
    expect(render([section])).toMatch(/<section data-block="section"[^>]* data-motion="rise" data-motion-children/);
    expect(render([section], 13)).not.toContain('data-motion');
  });
  it('moves the content of a hero, not its background', () => {
    const hero: Block = { id: 'h', type: 'core/hero', data: { heading: 'Rubrik', motion: 'fade' } };
    expect(render([hero])).toContain('data-motion-target=".block-hero-inner"');
  });
  it('marks repeaters and their aliases', () => {
    const grid: Block = { id: 'f', type: 'core/feature_grid', data: { motion: 'scale', items: [{ heading: 'A' }, { heading: 'B' }] } };
    expect(render([grid])).toMatch(/data-block="repeater"[^>]* data-motion="scale" data-motion-children/);
  });
  it('renders no motion on a site with reduced motion', () => {
    const section: Block = { id: 's', type: 'core/section', data: { motion: 'rise' }, children: [text] };
    expect(render([section], 14, { motion: 'reduced' })).not.toContain('data-motion');
  });
  it('ships the runtime only for pages that use it, and content stays visible without it', () => {
    const plain = collectBlockAssets([text], registry, { renderVersion: 14 });
    expect(plain.js).not.toContain('data-tr-motion');
    const moving = collectBlockAssets([{ id: 's', type: 'core/section', data: { motion: 'fade' }, children: [text] }], registry, { renderVersion: 14 });
    expect(moving.js).toContain("root.setAttribute('data-tr-motion', '')");
    // Hidden only under the attribute the runtime sets, and never in print.
    expect(moving.css).toMatch(/@media screen \{\s*html\[data-tr-motion\] \[data-motion-item\]/);
    expect(collectBlockAssets([{ id: 's', type: 'core/section', data: { motion: 'fade' }, children: [text] }], registry, { renderVersion: 13 }).js).not.toContain('data-tr-motion');
  });
});

describe('background media', () => {
  it('puts an image and a video behind a section, with white text over a darkening layer', () => {
    const section: Block = { id: 's', type: 'core/section', data: { background_image: '/media/hall.jpg', background_video: '/media/hall.mp4', background_overlay: 55 }, children: [text] };
    const html = render([section]);
    expect(html).toMatch(/<section data-block="section"[^>]*><div class="tr-bg-media" aria-hidden="true" style="--bg-overlay:0.55"><img src="\/media\/hall.jpg" alt="" loading="lazy" decoding="async" \/><video data-src="\/media\/hall.mp4" poster="\/media\/hall.jpg" data-phones="poster" muted loop playsinline preload="none"><\/video><\/div><button type="button" class="tr-bg-media-toggle"[^>]*aria-label="Pausa animationen" hidden>/);
    expect(html).toContain('data-bg-media="video"');
    expect(html).not.toContain('data-bg-own-fg');
  });
  it('keeps the author\'s text color and ignores provider pages', () => {
    const section: Block = { id: 's', type: 'core/section', data: { background_image: '/media/a.jpg', background_video: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', text_color: '#111111' }, children: [text] };
    const html = render([section]);
    expect(html).toContain('data-bg-media="image"');
    expect(html).toContain('data-bg-own-fg');
    expect(html).not.toContain('<video');
  });
  it('uses a container\'s and a CTA\'s own background image as the poster', () => {
    const container: Block = { id: 'c', type: 'core/container', data: { background_image: '/media/c.jpg', background_video: '/media/c.webm' }, children: [text] };
    expect(render([container])).toContain('poster="/media/c.jpg"');
    const cta: Block = { id: 'x', type: 'core/cta', data: { heading: 'Boka', background_image: '/media/x.jpg', image_position: 'background', background_video: '/media/x.mp4' } };
    expect(render([cta])).toMatch(/<section data-block="cta"[^>]*data-bg-media="video"[^>]*><div class="tr-bg-media"[^>]*><video data-src="\/media\/x.mp4" poster="\/media\/x.jpg"/);
  });
  it('shows only the image on a site with reduced motion and before version 14', () => {
    const section: Block = { id: 's', type: 'core/section', data: { background_image: '/media/hall.jpg', background_video: '/media/hall.mp4' }, children: [text] };
    const reduced = render([section], 14, { motion: 'reduced' });
    expect(reduced).toContain('data-bg-media="image"');
    expect(reduced).not.toContain('<video');
    expect(render([section], 13)).not.toContain('tr-bg-media');
  });
  it('keeps a background section out of the shared spacing between plain sections', () => {
    const assets = collectBlockAssets([{ id: 's', type: 'core/section', data: { background_image: '/a.jpg' }, children: [text] }], registry, { renderVersion: 14 });
    expect(assets.css).toContain('.tr-bg-media::after');
    expect(assets.js).not.toContain('data-src');
  });
});

describe('gallery lightbox', () => {
  const gallery: Block = { id: 'g', type: 'core/gallery', data: { items: [{ src: '/a.jpg', alt: 'A' }, { src: '/b.jpg', alt: 'B' }] } };
  it('opens images larger by default from version 14, with labels in the page language', () => {
    const html = render([gallery]);
    expect(html).toMatch(/data-block="repeater"[^>]* data-lightbox data-label-enlarge="Visa större" data-label-close="Stäng" data-label-previous="Föregående" data-label-next="Nästa"/);
    expect(render([gallery], 13)).not.toContain('data-lightbox');
    expect(render([{ ...gallery, data: { ...gallery.data, lightbox: false } }])).not.toContain('data-lightbox');
    expect(collectBlockAssets([gallery], registry, { renderVersion: 14 }).js).toContain('showModal');
  });
});

describe('logo marquee', () => {
  const logos: Block = { id: 'l', type: 'core/logo_cloud', data: { layout: 'marquee', items: [{ src: '/1.svg', alt: 'Ett' }, { src: '/2.svg', alt: 'Två' }] } };
  it('renders a track the runtime moves, and a still row without script or with reduced motion', () => {
    const html = render([logos]);
    expect(html).toMatch(/data-layout="marquee" data-label-pause="Pausa animationen" data-label-play="Spela animationen"[^>]*><div class="tr-marquee-track">/);
    expect(render([logos], 14, { motion: 'reduced' })).toContain('data-layout="marquee" data-static');
    const assets = collectBlockAssets([logos], registry, { renderVersion: 14 });
    expect(assets.js).toContain('[data-layout="marquee"]:not([data-static])');
    expect(assets.css).toContain('@keyframes tr-marquee');
  });
});

describe('text over media', () => {
  const image = { background_image: '/media/hall.jpg' };
  it('darkens from one side or behind the text, in the chosen color', () => {
    const html = render([{ id: 's', type: 'core/section', data: { ...image, overlay_style: 'gradient', overlay_side: 'start', overlay_color: '#1a2b3c' }, children: [text] }]);
    expect(html).toContain('data-overlay="gradient" data-overlay-side="start"');
    expect(html).toContain('--bg-overlay-color:#1a2b3c');
    const hero = render([{ id: 'h', type: 'core/hero', data: { heading: 'H', layout: 'full-image', image: '/h.jpg', overlay_style: 'spot', text_align: 'end', text_vertical: 'end' } }]);
    expect(hero).toContain('data-overlay="spot"');
    expect(hero).toContain('--spot-x:75%;--spot-y:75%');
  });
  it('refuses a color that could break out of the style attribute', () => {
    const html = render([{ id: 's', type: 'core/section', data: { ...image, overlay_color: 'red;background:url(x)' }, children: [text] }]);
    expect(html).not.toContain('url(x)');
  });
  it('puts a plate of the chosen kind and shape behind the text', () => {
    const html = render([{ id: 'c', type: 'core/cta', data: { heading: 'Boka', text_panel: 'dark_glass', text_panel_shape: 'blob' } }]);
    expect(html).toContain('data-panel="dark_glass" data-panel-shape="blob"');
    const css = collectBlockAssets([{ id: 'c', type: 'core/cta', data: { heading: 'Boka', text_panel: 'dark_glass' } }], registry, { renderVersion: 14 }).css;
    expect(css).toContain('backdrop-filter:blur(var(--panel-blur, 16px))');
    expect(css).toContain('[data-panel="dark_glass"][data-block="cta"] .block-cta-inner');
  });
  it('places a section\'s text per screen size', () => {
    const block: Block = { id: 's', type: 'core/section', data: { ...image, min_height: 'lg', text_position: { mobile: 'bottom-center', laptop: 'center-start' } as never }, children: [text] };
    const html = render([block]);
    expect(html).toContain('data-text-place data-min-h="lg"');
    expect(html).toContain('--text-y:flex-end;--text-margins:auto;');
    expect(html).toMatch(/@media \(min-width: \d+px\) \{ \[data-bid="s"\]\[data-bid="s"\] \{ --text-y:center;--text-margins:var\(--tr-edge\) auto;/);
  });
  it('changes nothing for a section that uses none of it, or before version 14', () => {
    const plain = render([{ id: 's', type: 'core/section', data: {}, children: [text] }]);
    expect(plain).not.toMatch(/data-(overlay|panel|text-place|min-h)/);
    expect(render([{ id: 's', type: 'core/section', data: { text_panel: 'solid', text_position: 'center' }, children: [text] }], 13)).not.toMatch(/data-(panel|text-place)/);
  });
  it('darkens a container\'s background video in a chosen color and direction, without a text plate', () => {
    const html = render([{ id: 'c', type: 'core/container', data: { background_image: '/c.jpg', background_video: '/c.mp4', overlay_style: 'gradient', overlay_side: 'top', overlay_color: '#102030', text_panel: 'dark_glass' }, children: [text] }]);
    expect(html).toContain('data-overlay="gradient" data-overlay-side="top"');
    expect(html).toContain('--bg-overlay-color:#102030');
    expect(html).not.toContain('data-panel');
  });
});
