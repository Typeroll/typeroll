import { describe, it, expect } from 'vitest';
import {
  buildCoreBlockRegistry,
  collectBlockAssets,
  providerEmbedUrl,
  ratingHtml,
  renderBlocks,
  type Block,
} from '../index.js';

const registry = buildCoreBlockRegistry();
const render = (block: Block, renderVersion = 7, language?: string) =>
  renderBlocks([block], { registry, renderVersion, context: language ? { site: { language } } : undefined });
const video = (data: Record<string, unknown>): Block => ({ id: 'v', type: 'core/video', data });

describe('core/video from render version 7', () => {
  const options = { autoplay: false, loop: false, controls: true };

  it('converts YouTube and Vimeo page addresses to embed addresses', () => {
    for (const address of [
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://youtu.be/dQw4w9WgXcQ',
      'https://www.youtube.com/shorts/dQw4w9WgXcQ',
      'https://www.youtube.com/embed/dQw4w9WgXcQ',
    ]) expect(providerEmbedUrl(address, options)).toBe('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?rel=0&playsinline=1');
    expect(providerEmbedUrl('https://youtu.be/dQw4w9WgXcQ?t=1m30s', options)).toContain('start=90');
    expect(providerEmbedUrl('https://vimeo.com/76979871', options)).toBe('https://player.vimeo.com/video/76979871?dnt=1');
    expect(providerEmbedUrl('https://vimeo.com/76979871/abcdef1234', options)).toContain('h=abcdef1234');
    expect(providerEmbedUrl('https://example.test/video', options)).toBe('');
  });

  it('applies autoplay (muted), loop and controls to embeds', () => {
    const url = providerEmbedUrl('https://youtu.be/dQw4w9WgXcQ', { autoplay: true, loop: true, controls: false });
    expect(url).toContain('autoplay=1');
    expect(url).toContain('mute=1');
    expect(url).toContain('loop=1&playlist=dQw4w9WgXcQ');
    expect(url).toContain('controls=0');
  });

  it('renders an embed with an accessible title and lazy loading', () => {
    const html = render(video({ source: 'youtube', video_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', title: 'Product tour' }));
    expect(html).toContain('<iframe src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?rel=0&amp;playsinline=1" title="Product tour" loading="lazy"');
    expect(render(video({ video_url: 'https://youtu.be/dQw4w9WgXcQ', lazy_load: false }))).not.toContain('loading="lazy"');
  });

  it('plays a file in the native player with every option', () => {
    const html = render(video({ source: 'url', video_url: '/media/clip.mp4', poster: '/media/poster.jpg', autoplay: true, loop: true, controls: false }));
    expect(html).toContain('<video src="/media/clip.mp4" poster="/media/poster.jpg" autoplay muted loop playsinline preload="metadata" aria-label="Video"></video>');
    expect(render(video({ source: 'url', video_url: '/media/clip.mp4', muted: false }))).toContain('<video src="/media/clip.mp4" controls playsinline preload="none" aria-label="Video">');
  });

  it('renders nothing for an address that is not http(s) or a path', () => {
    expect(render(video({ source: 'url', video_url: 'javascript:alert(1)' }))).toContain('<div data-block="video" data-source="url" style="--aspect_ratio:16:9" data-block-type="core/video"></div>');
  });

  it('keeps the bare iframe before version 7', () => {
    expect(render(video({ video_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }), 6)).toContain('<iframe src="https://www.youtube.com/watch?v=dQw4w9WgXcQ" loading="lazy" allowfullscreen></iframe>');
  });
});

describe('core/hero background video', () => {
  const hero = (data: Record<string, unknown>): Block => ({ id: 'h', type: 'core/hero', data: { heading: 'Hi', ...data } });

  it('plays a video file behind the text with a pause button and the image as poster', () => {
    const html = render(hero({ video_url: '/media/loop.mp4', image: '/media/still.jpg' }));
    expect(html).toContain('<video class="block-hero-video" src="/media/loop.mp4" poster="/media/still.jpg" autoplay muted loop playsinline preload="metadata" aria-hidden="true"></video>');
    expect(html).toContain('aria-label="Pause video" hidden>');
    expect(html).toContain('data-block-type="core/hero"');
    expect(render(hero({ video_url: '/media/loop.mp4' }), 7, 'sv')).toContain('aria-label="Pausa video"');
  });

  it('ignores YouTube addresses and leaves earlier versions unchanged', () => {
    expect(render(hero({ video_url: 'https://youtu.be/dQw4w9WgXcQ' }))).not.toContain('<video');
    const v6 = render(hero({ video_url: '/media/loop.mp4' }), 6);
    expect(v6).not.toContain('<video');
    expect(v6).not.toContain('data-block-type');
    expect(collectBlockAssets([hero({})], registry, { renderVersion: 6 }).js).not.toContain("register('core/hero'");
    expect(collectBlockAssets([hero({})], registry, { renderVersion: 7 }).js).toContain("register('core/hero'");
  });
});

describe('testimonial rating', () => {
  it('shows stars with a text alternative in the site language', () => {
    expect(ratingHtml(4, 'en')).toBe('<p class="block-testimonial-rating" role="img" aria-label="Rating: 4 out of 5">★★★★☆</p>');
    // Whole stars, and the text says the same number.
    expect(ratingHtml(4.4, 'sv')).toBe('<p class="block-testimonial-rating" role="img" aria-label="Betyg: 4 av 5">★★★★☆</p>');
    expect(ratingHtml(0, 'en')).toBe('');
    expect(ratingHtml(9, 'en')).toContain('5 out of 5');
    const block: Block = { id: 't', type: 'core/testimonial', data: { quote: '<p>Great</p>', rating: 5 } };
    expect(render(block)).toContain('★★★★★');
    expect(render(block, 6)).not.toContain('★');
  });

  it('reaches testimonials in a carousel', () => {
    const html = render({ id: 'list', type: 'core/testimonials', data: { items: [{ quote: 'A', rating: 3 }, { quote: 'B' }] } });
    expect(html).toContain('aria-label="Rating: 3 out of 5"');
  });
});

describe('carousel controls', () => {
  const carousel = (data: Record<string, unknown> = {}): Block => ({
    id: 'c', type: 'core/testimonials', data: { items: [{ quote: 'A' }, { quote: 'B' }, { quote: 'C' }], ...data },
  });

  it('wraps items in a track and adds arrows and a dot per item', () => {
    const html = render(carousel());
    expect(html).toMatch(/<div data-block="repeater"[^>]*data-layout="carousel" data-block-type="core\/repeater" data-carousel-autoplay="false" role="region" aria-roledescription="carousel" aria-label="Carousel"/);
    expect(html).toContain('<div class="tr-carousel-track"><figure data-block="testimonial"');
    expect(html).toContain('data-carousel-prev aria-label="Previous"');
    expect(html).toContain('data-carousel-next aria-label="Next"');
    expect(html.match(/data-carousel-to=/g)).toHaveLength(3);
    expect(html).toContain('<div class="tr-carousel-controls" hidden>');
    expect(html).not.toContain('data-carousel-pause');
  });

  it('follows the settings and adds a pause button for autoplay', () => {
    const html = render(carousel({ show_arrows: false, show_dots: false, autoplay: true }), 7, 'sv');
    expect(html).not.toContain('data-carousel-prev');
    expect(html).not.toContain('data-carousel-to');
    expect(html).toContain('data-carousel-autoplay="true"');
    expect(html).toContain('data-carousel-pause data-label-pause="Pausa" data-label-play="Spela" aria-label="Pausa"');
    expect(render(carousel({ show_arrows: false, show_dots: false }))).not.toContain('tr-carousel-controls');
  });

  it('keeps one item and earlier versions as they were', () => {
    expect(render(carousel({ items: [{ quote: 'A' }] }))).not.toContain('tr-carousel-controls');
    const v6 = render(carousel(), 6);
    expect(v6).not.toContain('tr-carousel-track');
    expect(v6).not.toContain('data-block-type');
    expect(collectBlockAssets([carousel()], registry, { renderVersion: 6 }).js).not.toContain("register('core/repeater'");
    expect(collectBlockAssets([carousel()], registry, { renderVersion: 7 }).js).toContain("register('core/repeater'");
  });
});

describe('forms', () => {
  it('passes the core/form block label to the form source', () => {
    const calls: unknown[] = [];
    renderBlocks([{ id: 'f', type: 'core/form', data: { form_id: 'contact', submit_label: 'Book a call' } }], {
      registry, formSource: (id, block) => { calls.push([id, block]); return '<form></form>'; },
    });
    expect(calls).toEqual([['contact', { submit_label: 'Book a call' }]]);
  });

  it('marks required choice groups for the browser', () => {
    const choices = [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }];
    const radio = render({ id: 'r', type: 'form/radio_group', data: { name: 'size', label: 'Size', required: true, choices } });
    expect(radio.match(/data-required="true"/g)).toHaveLength(2);
    const boxes = render({ id: 'c', type: 'form/checkbox_group', data: { name: 'topics', label: 'Topics', required: true, choices } });
    expect(boxes.match(/data-required-group="true"/g)).toHaveLength(2);
    const optional = render({ id: 'o', type: 'form/radio_group', data: { name: 'size', label: 'Size', choices } });
    expect(optional).not.toContain('data-required');
  });
});
