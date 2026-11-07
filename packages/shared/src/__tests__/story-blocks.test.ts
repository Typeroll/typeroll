import { describe, expect, it } from 'vitest';
import { buildCoreBlockRegistry, collectBlockAssets, renderBlocks, type Block } from '../index.js';
import { scrollFilmFrames } from '../story-blocks.js';

const registry = buildCoreBlockRegistry();
const render = (blocks: Block[], renderVersion = 14, site: Record<string, unknown> = {}) =>
  renderBlocks(blocks, { registry, renderVersion, context: { site: { language: 'sv', ...site }, page: { language: 'sv' } } as never });

describe('key figures', () => {
  const stats: Block = { id: 's', type: 'core/stats', data: { items: [{ value: '1 200', label: 'Kunder' }, { value: '98,5 %', label: 'Nöjda', description: 'Enkät 2026' }] } };
  it('renders every figure in the page as a description list', () => {
    const html = render([stats]);
    expect(html).toContain('<dl class="block-stats-list"><div class="block-stats-item"><dt class="block-stats-label">Kunder</dt><dd class="block-stats-value">1 200</dd></div>');
    expect(html).toContain('<dd class="block-stats-text">Enkät 2026</dd>');
  });
  it('does not count up on a site with reduced motion', () => {
    expect(render([stats])).toContain('data-count-up="true"');
    expect(render([stats], 14, { motion: 'reduced' })).toContain('data-count-up="false"');
  });
});

describe('timeline, audio and before/after', () => {
  it('renders a timeline as an ordered list and leaves out empty parts', () => {
    const html = render([{ id: 't', type: 'core/timeline', data: { items: [{ date: '2019', title: 'Start', text: '<p>Vi börjar.</p>' }, { title: 'Utan datum' }] } }]);
    expect(html).toContain('<ol class="block-timeline-list"><li class="block-timeline-item">');
    expect(html).toContain('<p class="block-timeline-date">2019</p><h3 class="block-timeline-title">Start</h3>');
    expect(html.match(/block-timeline-date/g)).toHaveLength(1);
    expect(html).not.toContain('<img');
  });
  it('gives the audio player its title as name and a transcript link in the page language', () => {
    const html = render([{ id: 'a', type: 'core/audio', data: { src: '/media/avsnitt.mp3', title: 'Avsnitt 1', transcript_url: '/utskrift/' } }]);
    expect(html).toContain('<audio class="block-audio-player" controls preload="metadata" src="/media/avsnitt.mp3" aria-label="Avsnitt 1"></audio>');
    expect(html).toContain('<a class="block-audio-transcript" href="/utskrift/">Utskrift</a>');
  });
  it('shows before and after side by side until the script adds the divider', () => {
    const html = render([{ id: 'b', type: 'core/before_after', data: { before_image: '/f.jpg', after_image: '/e.jpg', start: 30 } }]);
    expect(html).toContain('style="--ba-position:30%"');
    expect(html).toMatch(/<input class="block-ba-range" type="range" min="0" max="100" step="1" value="30" aria-label="Före \/ Efter" hidden \/>/);
    expect(registry.get('core/before_after')!.script).toContain("el.setAttribute('data-enhanced', '')");
  });
});

describe('announcement bar', () => {
  const bar = (text: string): Block => ({ id: 'n', type: 'core/announcement_bar', data: { text, link_url: '/tider/' } });
  it('names its region, labels the close button and links in the page language', () => {
    const html = render([bar('<p>Öppet lördagar</p>')]);
    expect(html).toContain('aria-label="Meddelande"');
    expect(html).toContain('aria-label="Stäng" hidden>');
    expect(html).toContain('<a class="block-announcement-link" href="/tider/">Läs mer</a>');
  });
  it('gets a new dismissal key when the message changes', () => {
    const key = (html: string) => html.match(/data-dismiss-key="([^"]+)"/)?.[1];
    expect(key(render([bar('<p>A</p>')]))).toBe(key(render([bar('<p>A</p>')])));
    expect(key(render([bar('<p>A</p>')]))).not.toBe(key(render([bar('<p>B</p>')])));
  });
});

describe('scroll steps', () => {
  it('renders every step with its own picture, and the sticky pictures for the script', () => {
    const html = render([{ id: 'p', type: 'core/scroll_steps', data: { items: [{ title: 'Ett', image: '/1.jpg', image_alt: 'Första' }, { title: 'Två' }] } }]);
    expect(html).toContain('<div class="block-steps-media" aria-hidden="true"><img class="block-steps-frame" src="/1.jpg" alt="" loading="lazy" decoding="async" data-step="0" /></div>');
    expect(html).toContain('<li class="block-steps-step" data-step="0"><img class="block-steps-step-media" src="/1.jpg" alt="Första"');
    expect(html).toContain('<li class="block-steps-step" data-step="1"><div class="block-steps-step-body"><h3 class="block-steps-title">Två</h3>');
  });
  it('never reads an item field from the block', () => {
    const html = render([{ id: 'p', type: 'core/scroll_steps', data: { image: '/leak.jpg', items: [{ title: 'Ett' }] } as never }]);
    expect(html).not.toContain('/leak.jpg');
  });
});

describe('scroll film', () => {
  it('expands a frame pattern and rejects unusable ones', () => {
    expect(scrollFilmFrames('/f/frame-{nnnn}.webp', 3, 1)).toEqual(['/f/frame-0001.webp', '/f/frame-0002.webp', '/f/frame-0003.webp']);
    expect(scrollFilmFrames('/f/{n}.jpg', 2, 0)).toEqual(['/f/0.jpg', '/f/1.jpg']);
    expect(scrollFilmFrames('/f/frame.webp', 3, 1)).toEqual([]);
    expect(scrollFilmFrames('/f/{n}.webp', 601, 1)).toEqual([]);
    expect(scrollFilmFrames('javascript:{n}', 3, 1)).toEqual([]);
  });
  it('renders the still image and captions, and the frames for the script', () => {
    const film: Block = { id: 'f', type: 'core/scroll_film', data: { frames_pattern: '/f/{nnn}.webp', frame_count: 120, description: 'Huset byggs', captions: [{ text: '<p>Grunden</p>', start: 0, end: 30 }] } };
    const html = render([film]);
    expect(html).toContain('data-film-pattern="/f/{nnn}.webp" data-film-count="120" data-film-first="1"');
    expect(html).toContain('<img class="block-film-poster" src="/f/001.webp" alt="Huset byggs"');
    expect(html).toContain('<div class="block-film-caption" data-start="0" data-end="30" data-position="end" data-align="start"><p>Grunden</p></div>');
  });
  it('uses a frame list or a video when there is no pattern', () => {
    expect(render([{ id: 'f', type: 'core/scroll_film', data: { frames: [{ src: '/a.webp' }, { src: '/b.webp' }] } }])).toContain('data-film-frames="[&quot;/a.webp&quot;,&quot;/b.webp&quot;]"');
    expect(render([{ id: 'f', type: 'core/scroll_film', data: { video: '/film.mp4', poster: '/still.jpg' } }])).toMatch(/data-film-video="\/film.mp4"[\s\S]*src="\/still.jpg"/);
  });
  it('stays a still image on a site with reduced motion', () => {
    const html = render([{ id: 'f', type: 'core/scroll_film', data: { frames_pattern: '/f/{nnn}.webp', frame_count: 3 } }], 14, { motion: 'reduced' });
    expect(html).not.toContain('data-film-');
    expect(html).toContain('src="/f/001.webp"');
  });
  it('ships each block\'s script only where the block is used', () => {
    const assets = collectBlockAssets([{ id: 'f', type: 'core/scroll_film', data: {} }], registry, { renderVersion: 14 });
    expect(assets.js).toContain("register('core/scroll_film'");
    expect(assets.js).not.toContain("register('core/scroll_steps'");
  });
});

describe('SVG animation', () => {
  const svg = '<svg viewBox="0 0 100 60" fill="none" stroke="currentColor"><path d="M10 50 L50 10 L90 50 Z"/></svg>';
  it('renders the drawing as authored, named for screen readers, with its trigger for the script', () => {
    const html = render([{ id: 'v', type: 'core/svg_animation', data: { svg, label: 'Ett tak', trigger: 'scroll', effect: 'draw_sequence', position: 40 } }]);
    expect(html).toContain('data-trigger="scroll" data-effect="draw_sequence"');
    expect(html).toContain('data-position="40"');
    expect(html).toContain('<div class="block-svg-stage" role="img" aria-label="Ett tak"><svg viewBox="0 0 100 60"');
    expect(html).toContain('data-label-pause="Pausa animationen"');
  });
  it('hides a drawing without a description from screen readers and escapes the description', () => {
    expect(render([{ id: 'v', type: 'core/svg_animation', data: { svg } }])).toContain('<div class="block-svg-stage" aria-hidden="true">');
    expect(render([{ id: 'v', type: 'core/svg_animation', data: { svg, label: 'A "quoted" <b>' } }])).toContain('aria-label="A &quot;quoted&quot; &lt;b&gt;"');
  });
  it('stays the finished drawing on a site with reduced motion', () => {
    expect(render([{ id: 'v', type: 'core/svg_animation', data: { svg } }], 14, { motion: 'reduced' })).toContain('data-static="true"');
    expect(registry.get('core/svg_animation')!.script).toContain("el.getAttribute('data-static') === 'true'");
  });
});
