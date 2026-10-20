// Markup for the media and carousel options of core blocks (render version 7).
//
// Before version 7 these fields were stored and never rendered: core/video was
// a bare iframe with the authored URL (a YouTube watch address does not embed),
// core/hero ignored video_url, core/testimonial ignored rating and the
// repeater carousel had no controls. The renderer derives the HTML here; the
// templates that include it exist only from version 7, so older sites keep
// their output byte for byte.

type Data = Record<string, unknown>;
type Lang = 'sv' | 'en';

const escapeAttr = (value: unknown) =>
  String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);

/** Interface language for the few words the platform writes itself. */
export function blockUiLanguage(language: unknown): Lang {
  return /^sv\b/i.test(String(language ?? '')) ? 'sv' : 'en';
}

const TEXT = {
  en: { pause: 'Pause video', play: 'Play video', previous: 'Previous', next: 'Next', item: 'Show item', pauseSlides: 'Pause', playSlides: 'Play', carousel: 'Carousel', rating: (value: string) => `Rating: ${value} out of 5` },
  sv: { pause: 'Pausa video', play: 'Spela video', previous: 'Föregående', next: 'Nästa', item: 'Visa', pauseSlides: 'Pausa', playSlides: 'Spela', carousel: 'Karusell', rating: (value: string) => `Betyg: ${value} av 5` },
} as const;

/** http(s) or a root-relative path; anything else is not a media address. */
function mediaAddress(value: unknown): string {
  const url = String(value ?? '').trim();
  if (/^\/(?!\/)/.test(url)) return url;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : '';
  } catch {
    return '';
  }
}

const YOUTUBE = /^(?:https?:)?\/\/(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?(?:[^#]*&)?v=|embed\/|shorts\/|live\/)|youtu\.be\/|youtube-nocookie\.com\/embed\/)([A-Za-z0-9_-]{11})/;
const VIMEO = /^(?:https?:)?\/\/(?:www\.|player\.)?vimeo\.com\/(?:video\/)?(\d{4,12})(?:\/([0-9a-f]{6,20}))?/;

/** Seconds from a YouTube `t`/`start` value such as 90, 90s or 1m30s. */
function startSeconds(url: URL): number {
  const raw = url.searchParams.get('start') ?? url.searchParams.get('t') ?? '';
  const match = raw.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/);
  if (!raw || !match) return 0;
  return Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0);
}

/**
 * The embed address for a YouTube or Vimeo page address, with the block's
 * options. YouTube uses its no-cookie host. Embedded players start muted only
 * when they autoplay, which browsers require; otherwise the visitor controls
 * sound in the player.
 */
export function providerEmbedUrl(address: string, options: { autoplay: boolean; loop: boolean; controls: boolean }): string {
  const youtube = address.match(YOUTUBE);
  if (youtube) {
    const id = youtube[1];
    const params = new URLSearchParams({ rel: '0', playsinline: '1' });
    if (options.autoplay) { params.set('autoplay', '1'); params.set('mute', '1'); }
    if (options.loop) { params.set('loop', '1'); params.set('playlist', id); }
    if (!options.controls) params.set('controls', '0');
    try { const start = startSeconds(new URL(address, 'https://www.youtube.com')); if (start) params.set('start', String(start)); } catch { /* no start time */ }
    return `https://www.youtube-nocookie.com/embed/${id}?${params}`;
  }
  const vimeo = address.match(VIMEO);
  if (vimeo) {
    const params = new URLSearchParams({ dnt: '1' });
    if (vimeo[2]) params.set('h', vimeo[2]);
    if (options.autoplay) { params.set('autoplay', '1'); params.set('muted', '1'); }
    if (options.loop) params.set('loop', '1');
    if (!options.controls) params.set('controls', '0');
    return `https://player.vimeo.com/video/${vimeo[1]}?${params}`;
  }
  return '';
}

/** The player for core/video. Empty when there is no usable address. */
export function videoPlayerHtml(data: Data): string {
  const address = mediaAddress(data.video_url);
  if (!address) return '';
  const title = String(data.title ?? '').trim() || 'Video';
  const autoplay = data.autoplay === true;
  const loop = data.loop === true;
  const controls = data.controls !== false;
  const lazy = data.lazy_load !== false;
  if (data.source === 'url') {
    const poster = mediaAddress(data.poster);
    const attrs = [
      `src="${escapeAttr(address)}"`,
      poster ? `poster="${escapeAttr(poster)}"` : '',
      controls ? 'controls' : '',
      autoplay ? 'autoplay' : '',
      // Browsers only autoplay muted video.
      autoplay || data.muted !== false ? 'muted' : '',
      loop ? 'loop' : '',
      'playsinline',
      `preload="${lazy && !autoplay ? 'none' : 'metadata'}"`,
      `aria-label="${escapeAttr(title)}"`,
    ].filter(Boolean).join(' ');
    return `<video ${attrs}></video>`;
  }
  // A YouTube or Vimeo page address becomes the embed address; an address the
  // block cannot convert is kept and left to the iframe host allowlist.
  const src = providerEmbedUrl(address, { autoplay, loop, controls }) || address;
  return `<iframe src="${escapeAttr(src)}" title="${escapeAttr(title)}"${lazy ? ' loading="lazy"' : ''} allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>`;
}

const PAUSE_ICON = '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true" focusable="false"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>';
const PLAY_ICON = '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true" focusable="false"><path d="M8 5v14l11-7z"/></svg>';

/**
 * A hero's background video: a video file, muted and looping behind the text,
 * with the hero image as its poster and a pause button the runtime reveals.
 * YouTube and Vimeo addresses are not background videos and render nothing.
 */
export function heroVideoHtml(data: Data, language: unknown): string {
  const address = mediaAddress(data.video_url);
  if (!address || YOUTUBE.test(address) || VIMEO.test(address)) return '';
  const text = TEXT[blockUiLanguage(language)];
  const poster = mediaAddress(data.image);
  return `<video class="block-hero-video" src="${escapeAttr(address)}"${poster ? ` poster="${escapeAttr(poster)}"` : ''} autoplay muted loop playsinline preload="metadata" aria-hidden="true"></video>`
    + `<button type="button" class="block-hero-video-toggle" data-label-pause="${escapeAttr(text.pause)}" data-label-play="${escapeAttr(text.play)}" aria-label="${escapeAttr(text.pause)}" hidden>${PAUSE_ICON}</button>`;
}

/**
 * A testimonial rating (0–5) as whole stars with a matching text
 * alternative: what a sighted visitor counts and what a screen reader says
 * are the same number.
 */
export function ratingHtml(rating: unknown, language: unknown): string {
  if (typeof rating !== 'number' || !Number.isFinite(rating)) return '';
  const stars = Math.min(5, Math.round(rating));
  if (stars <= 0) return '';
  const lang = blockUiLanguage(language);
  return `<p class="block-testimonial-rating" role="img" aria-label="${escapeAttr(TEXT[lang].rating(String(stars)))}">${'★'.repeat(stars)}${'☆'.repeat(5 - stars)}</p>`;
}

const ARROW_LEFT = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="m15 18-6-6 6-6"/></svg>';
const ARROW_RIGHT = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="m9 18 6-6-6-6"/></svg>';

/**
 * Carousel controls, hidden until the runtime has something to control.
 * Without JavaScript the track still scrolls and these stay hidden.
 */
export function carouselControlsHtml(data: Data, count: number, language: unknown): string {
  const arrows = data.show_arrows !== false;
  const dots = data.show_dots !== false;
  const autoplay = data.autoplay === true;
  if (count < 2 || (!arrows && !dots && !autoplay)) return '';
  const text = TEXT[blockUiLanguage(language)];
  const parts: string[] = [];
  if (autoplay) parts.push(`<button type="button" class="tr-carousel-button" data-carousel-pause data-label-pause="${escapeAttr(text.pauseSlides)}" data-label-play="${escapeAttr(text.playSlides)}" aria-label="${escapeAttr(text.pauseSlides)}">${PAUSE_ICON}</button>`);
  if (arrows) parts.push(`<button type="button" class="tr-carousel-button" data-carousel-prev aria-label="${escapeAttr(text.previous)}">${ARROW_LEFT}</button>`);
  if (dots) {
    parts.push(`<div class="tr-carousel-dots">${Array.from({ length: Math.min(count, 50) }, (_, i) =>
      `<button type="button" class="tr-carousel-dot" data-carousel-to="${i}" aria-label="${escapeAttr(`${text.item} ${i + 1}`)}"></button>`).join('')}</div>`);
  }
  if (arrows) parts.push(`<button type="button" class="tr-carousel-button" data-carousel-next aria-label="${escapeAttr(text.next)}">${ARROW_RIGHT}</button>`);
  return `<div class="tr-carousel-controls" hidden>${parts.join('')}</div>`;
}

export function carouselRegionLabel(language: unknown): string {
  return TEXT[blockUiLanguage(language)].carousel;
}

/** Runtime for the hero background video's pause button. */
export const HERO_VIDEO_RUNTIME = String.raw`
window.TyperollBlocks.register('core/hero', function (el) {
  var video = el.querySelector(':scope > .block-hero-video');
  var toggle = el.querySelector(':scope > .block-hero-video-toggle');
  if (!video || !toggle) return;
  // Reduced motion: CSS hides the video; stop it downloading and playing too.
  if (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) { video.removeAttribute('autoplay'); video.pause(); return; }
  var PAUSE = ${JSON.stringify(PAUSE_ICON)}, PLAY = ${JSON.stringify(PLAY_ICON)};
  function show(paused) { toggle.setAttribute('aria-label', paused ? toggle.dataset.labelPlay : toggle.dataset.labelPause); toggle.innerHTML = paused ? PLAY : PAUSE; }
  toggle.hidden = false;
  toggle.addEventListener('click', function () {
    if (video.paused) { var played = video.play(); if (played && played.catch) played.catch(function () {}); show(false); }
    else { video.pause(); show(true); }
  });
});
`;

/** Runtime for repeater carousels: arrows, dots and autoplay with pause. */
export const CAROUSEL_RUNTIME = String.raw`
window.TyperollBlocks.register('core/repeater', function (el) {
  var track = el.querySelector(':scope > .tr-carousel-track');
  var controls = el.querySelector(':scope > .tr-carousel-controls');
  if (!track || !controls) return;
  var items = Array.prototype.slice.call(track.children);
  if (items.length < 2) return;
  var reduced = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  var prev = controls.querySelector('[data-carousel-prev]');
  var next = controls.querySelector('[data-carousel-next]');
  var pause = controls.querySelector('[data-carousel-pause]');
  var dots = Array.prototype.slice.call(controls.querySelectorAll('[data-carousel-to]'));
  var PAUSE = ${JSON.stringify(PAUSE_ICON)}, PLAY = ${JSON.stringify(PLAY_ICON)};
  function position(i) { return items[i].offsetLeft - items[0].offsetLeft; }
  function maxScroll() { return track.scrollWidth - track.clientWidth; }
  function current() {
    var best = 0, distance = Infinity;
    for (var i = 0; i < items.length; i++) { var d = Math.abs(Math.min(position(i), maxScroll()) - track.scrollLeft); if (d < distance - 1) { distance = d; best = i; } }
    return best;
  }
  function go(i) { track.scrollTo({ left: Math.min(position(Math.max(0, Math.min(items.length - 1, i))), maxScroll()), behavior: reduced ? 'auto' : 'smooth' }); }
  function update() {
    var at = current();
    if (prev) prev.disabled = track.scrollLeft <= 1;
    if (next) next.disabled = track.scrollLeft >= maxScroll() - 1;
    dots.forEach(function (dot, i) { if (i === at) dot.setAttribute('aria-current', 'true'); else dot.removeAttribute('aria-current'); });
  }
  if (prev) prev.addEventListener('click', function () { go(current() - 1); });
  if (next) next.addEventListener('click', function () { go(current() + 1); });
  dots.forEach(function (dot) { dot.addEventListener('click', function () { go(Number(dot.dataset.carouselTo)); }); });
  var frame = 0;
  track.addEventListener('scroll', function () { if (!frame) frame = requestAnimationFrame(function () { frame = 0; update(); }); }, { passive: true });
  window.addEventListener('resize', update);
  controls.hidden = false;
  update();
  // Autoplay advances every 5 s and stops while the visitor points at or
  // focuses the carousel, while the tab is hidden, after they press pause,
  // and entirely when they prefer reduced motion.
  if (!pause) return;
  if (reduced || el.dataset.carouselAutoplay !== 'true') { pause.hidden = true; return; }
  var stopped = false, hovering = false, focused = false;
  function show() { pause.setAttribute('aria-label', stopped ? pause.dataset.labelPlay : pause.dataset.labelPause); pause.innerHTML = stopped ? PLAY : PAUSE; }
  pause.addEventListener('click', function () { stopped = !stopped; show(); });
  el.addEventListener('mouseenter', function () { hovering = true; });
  el.addEventListener('mouseleave', function () { hovering = false; });
  el.addEventListener('focusin', function () { focused = true; });
  el.addEventListener('focusout', function (event) { if (!el.contains(event.relatedTarget)) focused = false; });
  setInterval(function () {
    if (stopped || hovering || focused || document.hidden || !el.isConnected) return;
    if (track.scrollLeft >= maxScroll() - 1) go(0); else go(current() + 1);
  }, 5000);
});
`;
