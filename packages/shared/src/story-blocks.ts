// Story blocks: key figures, a timeline, an audio player, a before/after
// image comparison, an announcement bar, scroll steps, a scroll film and an
// animated SVG.
//
// Every block is complete without script. Its runtime only enhances: count
// figures up, make a comparison draggable, let a visitor dismiss a notice,
// keep a picture beside the steps that scroll past, or draw a film frame by
// frame as the page scrolls. Visitors who prefer reduced motion, and sites
// with `motion: "reduced"`, get the still version.
//
// Hooks for a site's own CSS and scripts:
// - scroll_steps: [data-active] on the current step and frame,
//   --steps-top, and the `typeroll:step-change` event ({ index });
// - scroll_film: --film-progress (0–1) on the block, [data-visible] on the
//   captions on screen, [data-film-ready], and the `typeroll:film-progress`
//   event ({ progress, frame });
// - svg_animation: --svg-progress (0–1), [data-svg-state] (idle, running,
//   done) and the `typeroll:svg-progress` event ({ progress }).

import type { BlockType } from './types.js';
import { mediaAddress, videoFileAddress } from './block-media.js';
import { uiLabel } from './ui-text.js';

const ISO_EPOCH = '1970-01-01T00:00:00Z';
const RUNTIME_GUARD = 'window.TyperollBlocks = window.TyperollBlocks || { register(){}, init(){} };';
const CLOSE_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true" focusable="false"><path d="M6 6l12 12M18 6 6 18"/></svg>';

const stats: BlockType = {
  id: 'core/stats',
  name: 'stats',
  label: 'Key figures',
  icon: 'chart-column',
  category: 'content',
  container: false,
  parts: [
    { name: 'value', label: 'Figure', selector: '.block-stats-value', target: 'heading' },
    { name: 'label', label: 'Label', selector: '.block-stats-label', target: 'text' },
    { name: 'text', label: 'Description', selector: '.block-stats-text', target: 'text' },
    { name: 'item', label: 'Figure card', selector: '.block-stats-item', target: 'container', decorative: true },
  ],
  schema: [
    { name: 'style_id', type: 'style', label: 'Style', style_target: 'container', editor_group: 'content' },
    { name: 'items', type: 'array', label: 'Figures', fields: [
      { name: 'value', type: 'text', label: 'Figure', placeholder: '120, 98 %, 15+' },
      { name: 'label', type: 'text', label: 'Label', placeholder: 'Customers' },
      { name: 'description', type: 'text', label: 'Description' },
    ] },
    { name: 'cols', type: 'number', label: 'Columns (most)', default: 4, min: 1, max: 6 },
    { name: 'align', type: 'select', label: 'Alignment', options: ['center', 'start'], default: 'center' },
    { name: 'style', type: 'select', label: 'Look', options: ['plain', 'cards', 'divided'], option_labels: ['Plain', 'Cards', 'Line above'], default: 'plain' },
    { name: 'count_up', type: 'boolean', label: 'Count up when scrolled into view', default: true, help: 'Numbers count up from zero once. The final figure is in the page for search engines and visitors without script.' },
  ],
  template: `<div data-block="stats" data-style="{{style}}" data-align="{{align}}" data-count-up="{{count_up}}" style="--cols:{{cols}}"><dl class="block-stats-list">{{#each items}}<div class="block-stats-item"><dt class="block-stats-label">{{label}}</dt><dd class="block-stats-value">{{value}}</dd>{{#description}}<dd class="block-stats-text">{{description}}</dd>{{/description}}</div>{{/each}}</dl></div>`,
  styles: `
[data-block="stats"] { container-type:inline-size; }
[data-block="stats"] .block-stats-list { --stats-gap:2rem; display:grid; grid-template-columns:repeat(auto-fit, minmax(max(9rem, calc((100% - (var(--cols, 4) - 1) * var(--stats-gap)) / var(--cols, 4))), 1fr)); gap:var(--stats-gap); margin:0; }
[data-block="stats"] .block-stats-item { display:flex; flex-direction:column; gap:.25rem; min-width:0; }
[data-block="stats"][data-align="center"] .block-stats-item { align-items:center; text-align:center; }
[data-block="stats"] .block-stats-value { order:-1; margin:0; font-size:clamp(2rem, 1.25rem + 4cqi, 3.25rem); font-weight:700; line-height:1.05; letter-spacing:-.02em; color:var(--color-primary, #111); font-variant-numeric:tabular-nums; }
[data-block="stats"] .block-stats-label { margin:0; font-weight:600; }
[data-block="stats"] .block-stats-text { margin:0; font-size:.9375rem; color:var(--color-text-light, #64748b); }
[data-block="stats"][data-style="cards"] .block-stats-item { padding:1.5rem 1.25rem; border-radius:.75rem; background:var(--color-surface, #f8fafc); }
[data-block="stats"][data-style="divided"] .block-stats-item { padding-block-start:1rem; border-block-start:2px solid var(--color-primary, #111); }
`.trim(),
  script: `${RUNTIME_GUARD}
window.TyperollBlocks.register('core/stats', function (el) {
  if (el.getAttribute('data-count-up') === 'false' || !('IntersectionObserver' in window)) return;
  if (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  var height = window.innerHeight;
  el.querySelectorAll('.block-stats-value').forEach(function (node) {
    var text = node.textContent || '';
    var match = text.match(/\\d(?:[\\d\\s.,'\\u00a0\\u202f]*\\d)?/);
    if (!match) return;
    var raw = match[0];
    // A last separator followed by one or two digits is the decimal mark; any other is grouping.
    var decimal = raw.match(/([.,])(\\d{1,2})$/);
    var others = decimal ? raw.slice(0, -decimal[0].length) : raw;
    if (decimal && others.indexOf(decimal[1]) !== -1) decimal = null;
    var places = decimal ? decimal[2].length : 0;
    var group = (decimal ? raw.slice(0, -decimal[0].length) : raw).match(/[^\\d]/);
    var digits = raw.replace(/[^\\d.,]/g, '');
    var target = parseFloat(decimal ? digits.slice(0, -decimal[0].length).replace(/[.,]/g, '') + '.' + decimal[2] : digits.replace(/[.,]/g, ''));
    if (!isFinite(target)) return;
    var rect = node.getBoundingClientRect();
    if (rect.top < height && rect.bottom > 0) return;
    function format(value) {
      var fixed = value.toFixed(places).split('.');
      var whole = group ? fixed[0].replace(/\\B(?=(\\d{3})+(?!\\d))/g, group[0]) : fixed[0];
      return text.replace(raw, whole + (places ? decimal[1] + fixed[1] : ''));
    }
    // The final figure stays in the page until the figure enters, so anything that reads the
    // page without scrolling (a crawler, a printout) gets the real number.
    var observer = new IntersectionObserver(function (entries) {
      if (!entries[0].isIntersecting) return;
      observer.disconnect();
      node.style.minInlineSize = node.getBoundingClientRect().width + 'px';
      node.textContent = format(0);
      var start = performance.now(), duration = 1200;
      (function step(now) {
        var t = Math.min(1, (now - start) / duration), eased = 1 - Math.pow(1 - t, 3);
        node.textContent = t < 1 ? format(target * eased) : text;
        if (t < 1) requestAnimationFrame(step); else node.style.minInlineSize = '';
      })(start);
    }, { rootMargin: '0px 0px -10% 0px' });
    observer.observe(node);
  });
});`,
  origin: 'core',
  created_at: ISO_EPOCH,
};

const timeline: BlockType = {
  id: 'core/timeline',
  name: 'timeline',
  label: 'Timeline',
  icon: 'milestone',
  category: 'content',
  container: false,
  parts: [
    { name: 'date', label: 'Date', selector: '.block-timeline-date', target: 'text' },
    { name: 'title', label: 'Title', selector: '.block-timeline-title', target: 'heading' },
    { name: 'text', label: 'Text', selector: '.block-timeline-text', target: 'text' },
    { name: 'marker', label: 'Marker', selector: '.block-timeline-marker', target: 'container', decorative: true },
  ],
  schema: [
    { name: 'style_id', type: 'style', label: 'Style', style_target: 'container', editor_group: 'content' },
    { name: 'items', type: 'array', label: 'Events', fields: [
      { name: 'date', type: 'text', label: 'Date or period', placeholder: '2019' },
      { name: 'title', type: 'text', label: 'Title' },
      { name: 'text', type: 'richtext', label: 'Text' },
      { name: 'image', type: 'image', label: 'Image' },
      { name: 'image_alt', type: 'text', label: 'Image description' },
    ] },
    { name: 'layout', type: 'select', label: 'Layout', options: ['line', 'alternate'], option_labels: ['One line', 'Alternating sides on wide screens'], default: 'line' },
  ],
  template: `<div data-block="timeline" data-layout="{{layout}}"><ol class="block-timeline-list">{{#each items}}<li class="block-timeline-item"><span class="block-timeline-marker" aria-hidden="true"></span><div class="block-timeline-body">{{#date}}<p class="block-timeline-date">{{date}}</p>{{/date}}{{#title}}<h3 class="block-timeline-title">{{title}}</h3>{{/title}}{{#image}}<img class="block-timeline-image" src="{{image}}" alt="{{image_alt}}" loading="lazy" decoding="async" />{{/image}}<div class="block-timeline-text">{{{text}}}</div></div></li>{{/each}}</ol></div>`,
  styles: `
[data-block="timeline"] { container-type:inline-size; }
[data-block="timeline"] .block-timeline-list { display:grid; gap:var(--timeline-gap, 2rem); margin:0; padding:0; list-style:none; }
[data-block="timeline"] .block-timeline-item { position:relative; padding-inline-start:var(--timeline-indent, 2.25rem); }
/* Each event draws the line from its marker to the next event. */
[data-block="timeline"] .block-timeline-item:not(:last-child)::before { content:""; position:absolute; inset-block:.8rem calc(-1 * var(--timeline-gap, 2rem) - .3rem); inset-inline-start:.5rem; inline-size:2px; translate:-50% 0; background:var(--timeline-line, color-mix(in srgb, currentColor 18%, transparent)); }
[data-block="timeline"] .block-timeline-marker { position:absolute; z-index:1; inset-inline-start:0; inset-block-start:.3rem; inline-size:1rem; block-size:1rem; border-radius:50%; background:var(--color-background, #fff); box-shadow:inset 0 0 0 3px var(--color-primary, #111); }
[data-block="timeline"] .block-timeline-date { margin:0 0 .25rem; font-size:.875rem; font-weight:600; letter-spacing:.02em; color:var(--color-primary, #111); }
[data-block="timeline"] .block-timeline-title { margin:0 0 .5rem; font-size:var(--type-h4, 1.25rem); line-height:1.3; }
[data-block="timeline"] .block-timeline-image { display:block; inline-size:100%; max-inline-size:28rem; block-size:auto; margin-block:var(--timeline-image-space, .5rem .75rem); border-radius:var(--timeline-image-radius, .5rem); }
[data-block="timeline"] .block-timeline-text > :first-child { margin-block-start:0; }
[data-block="timeline"] .block-timeline-text > :last-child { margin-block-end:0; }
@container (min-width: 46rem) {
  [data-block="timeline"][data-layout="alternate"] .block-timeline-item:not(:last-child)::before { inset-inline-start:50%; }
  [data-block="timeline"][data-layout="alternate"] .block-timeline-item { display:grid; grid-template-columns:1fr 2.5rem 1fr; padding:0; }
  [data-block="timeline"][data-layout="alternate"] .block-timeline-marker { position:static; grid-column:2; grid-row:1; justify-self:center; margin-block-start:.3rem; }
  [data-block="timeline"][data-layout="alternate"] .block-timeline-item:nth-child(odd) .block-timeline-body { grid-column:1; grid-row:1; text-align:end; }
  [data-block="timeline"][data-layout="alternate"] .block-timeline-item:nth-child(odd) .block-timeline-image { margin-inline-start:auto; }
  [data-block="timeline"][data-layout="alternate"] .block-timeline-item:nth-child(even) .block-timeline-body { grid-column:3; grid-row:1; }
}
`.trim(),
  origin: 'core',
  created_at: ISO_EPOCH,
};

const audio: BlockType = {
  id: 'core/audio',
  name: 'audio',
  label: 'Audio',
  icon: 'audio-lines',
  category: 'media',
  container: false,
  parts: [
    { name: 'title', label: 'Title', selector: '.block-audio-title', target: 'heading' },
    { name: 'text', label: 'Description', selector: '.block-audio-text', target: 'text' },
    { name: 'cover', label: 'Cover', selector: '.block-audio-cover', target: 'image' },
  ],
  schema: [
    { name: 'style_id', type: 'style', label: 'Style', style_target: 'container', editor_group: 'content' },
    { name: 'src', type: 'url', label: 'Audio file (MP3, M4A, OGG)', required: true },
    { name: 'title', type: 'text', label: 'Title' },
    { name: 'description', type: 'richtext', label: 'Description' },
    { name: 'cover', type: 'image', label: 'Cover image' },
    { name: 'transcript_url', type: 'url', label: 'Transcript link' },
    { name: 'transcript_label', type: 'text', label: 'Transcript link text', default: 'Transcript', ui_text: 'transcript' },
  ],
  template: `<figure data-block="audio">{{#cover}}<img class="block-audio-cover" src="{{cover}}" alt="" loading="lazy" decoding="async" />{{/cover}}<div class="block-audio-body">{{#title}}<figcaption class="block-audio-title">{{title}}</figcaption>{{/title}}<div class="block-audio-text">{{{description}}}</div><audio class="block-audio-player" controls preload="metadata" src="{{src}}" aria-label="{{title}}"></audio>{{#transcript_url}}<a class="block-audio-transcript" href="{{transcript_url}}">{{transcript_label}}</a>{{/transcript_url}}</div></figure>`,
  styles: `
[data-block="audio"] { container-type:inline-size; display:grid; grid-template-columns:auto 1fr; gap:1rem 1.25rem; align-items:center; margin:0; padding:1.25rem; border-radius:.75rem; background:var(--color-surface, #f8fafc); }
[data-block="audio"]:not(:has(.block-audio-cover)) { grid-template-columns:1fr; }
[data-block="audio"] .block-audio-cover { inline-size:clamp(4.5rem, 20cqi, 8rem); aspect-ratio:1; object-fit:cover; border-radius:.5rem; }
[data-block="audio"] .block-audio-body { display:grid; gap:var(--audio-gap, .5rem); min-width:0; }
[data-block="audio"] .block-audio-title { text-align:start; font-weight:700; font-size:1.125rem; line-height:1.3; }
[data-block="audio"] .block-audio-text:empty { display:none; }
[data-block="audio"] .block-audio-text > * { margin:0; }
[data-block="audio"] .block-audio-player { inline-size:100%; }
[data-block="audio"] .block-audio-transcript { justify-self:start; font-size:var(--audio-link-size, .9375rem); }
@container (max-width: 26rem) { [data-block="audio"] { grid-template-columns:1fr; } }
`.trim(),
  origin: 'core',
  created_at: ISO_EPOCH,
};

const beforeAfter: BlockType = {
  id: 'core/before_after',
  name: 'before_after',
  label: 'Before and after',
  icon: 'columns-2',
  category: 'media',
  container: false,
  parts: [
    { name: 'label', label: 'Before and after labels', selector: '.block-ba-label', target: 'text', decorative: true },
  ],
  schema: [
    { name: 'before_image', type: 'image', label: 'Before image', required: true },
    { name: 'before_alt', type: 'text', label: 'Before image description' },
    { name: 'after_image', type: 'image', label: 'After image', required: true },
    { name: 'after_alt', type: 'text', label: 'After image description' },
    { name: 'before_label', type: 'text', label: 'Before label', default: 'Before', ui_text: 'before' },
    { name: 'after_label', type: 'text', label: 'After label', default: 'After', ui_text: 'after' },
    { name: 'start', type: 'number', label: 'Divider start position (%)', default: 50, min: 0, max: 100 },
    { name: 'aspect_ratio', type: 'select', label: 'Aspect ratio', options: ['auto', '16:9', '4:3', '1:1', '3:4'], default: 'auto' },
  ],
  template: `<figure data-block="before_after" data-aspect="{{aspect_ratio}}" style="--ba-position:{{start}}%"><div class="block-ba-stage"><div class="block-ba-pane block-ba-after"><img src="{{after_image}}" alt="{{after_alt}}" loading="lazy" decoding="async" /><span class="block-ba-label">{{after_label}}</span></div><div class="block-ba-pane block-ba-before"><img src="{{before_image}}" alt="{{before_alt}}" loading="lazy" decoding="async" /><span class="block-ba-label">{{before_label}}</span></div><input class="block-ba-range" type="range" min="0" max="100" step="1" value="{{start}}" aria-label="{{before_label}} / {{after_label}}" hidden /><span class="block-ba-handle" aria-hidden="true"></span></div></figure>`,
  styles: `
[data-block="before_after"] { margin:0; }
/* Without script the two images stand side by side, before first. */
[data-block="before_after"] { --ba-radius:.5rem; --ba-handle-color:#fff; }
[data-block="before_after"] .block-ba-stage { display:grid; grid-template-columns:1fr 1fr; gap:var(--ba-gap, .5rem); }
[data-block="before_after"] .block-ba-before { grid-column:1; grid-row:1; }
[data-block="before_after"] .block-ba-after { grid-column:2; grid-row:1; }
[data-block="before_after"] .block-ba-pane { position:relative; overflow:hidden; border-radius:var(--ba-radius); }
[data-block="before_after"] .block-ba-pane img { display:block; inline-size:100%; block-size:100%; object-fit:cover; }
[data-block="before_after"] .block-ba-label { position:absolute; inset-block-start:.75rem; inset-inline-start:.75rem; padding:.25rem .625rem; border-radius:999px; background:rgb(0 0 0 / .6); color:#fff; font-size:.8125rem; font-weight:600; }
[data-block="before_after"] .block-ba-label:empty { display:none; }
[data-block="before_after"] .block-ba-handle { display:none; }
[data-block="before_after"][data-enhanced] .block-ba-stage { position:relative; display:grid; grid-template-columns:1fr; gap:0; overflow:hidden; border-radius:var(--ba-radius); touch-action:pan-y; }
[data-block="before_after"][data-aspect="16:9"][data-enhanced] .block-ba-stage { aspect-ratio:16/9; }
[data-block="before_after"][data-aspect="4:3"][data-enhanced] .block-ba-stage { aspect-ratio:4/3; }
[data-block="before_after"][data-aspect="1:1"][data-enhanced] .block-ba-stage { aspect-ratio:1; }
[data-block="before_after"][data-aspect="3:4"][data-enhanced] .block-ba-stage { aspect-ratio:3/4; }
[data-block="before_after"][data-enhanced] .block-ba-pane { grid-area:1/1; border-radius:0; }
[data-block="before_after"][data-enhanced] .block-ba-before { clip-path:inset(0 calc(100% - var(--ba-position, 50%)) 0 0); }
[data-block="before_after"][data-enhanced] .block-ba-after .block-ba-label { inset-inline:auto .75rem; }
[data-block="before_after"][data-enhanced] .block-ba-range { position:absolute; inset:0; z-index:2; inline-size:100%; block-size:100%; margin:0; opacity:0; cursor:ew-resize; }
[data-block="before_after"][data-enhanced] .block-ba-handle { display:block; position:absolute; z-index:1; inset-block:0; inset-inline-start:var(--ba-position, 50%); inline-size:3px; translate:-50% 0; background:var(--ba-handle-color); box-shadow:var(--ba-handle-shadow, 0 0 0 1px rgb(0 0 0 / .2)); pointer-events:none; }
[data-block="before_after"][data-enhanced] .block-ba-handle::after { content:""; position:absolute; inset-block-start:50%; inset-inline-start:50%; inline-size:2.5rem; block-size:2.5rem; translate:-50% -50%; border-radius:var(--ba-knob-radius, 50%); background:var(--ba-handle-color) center/1.25rem no-repeat url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23111' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m9 18-6-6 6-6M15 6l6 6-6 6'/%3E%3C/svg%3E"); box-shadow:var(--ba-knob-shadow, 0 2px 8px rgb(0 0 0 / .3)); }
[data-block="before_after"] .block-ba-range:focus-visible + .block-ba-handle::after { outline:3px solid var(--color-primary, #111); outline-offset:2px; }
`.trim(),
  script: `${RUNTIME_GUARD}
window.TyperollBlocks.register('core/before_after', function (el) {
  var range = el.querySelector('.block-ba-range');
  if (!range) return;
  el.setAttribute('data-enhanced', '');
  range.hidden = false;
  function update() { el.style.setProperty('--ba-position', range.value + '%'); }
  range.addEventListener('input', update);
  update();
});`,
  origin: 'core',
  created_at: ISO_EPOCH,
};

const announcementBar: BlockType = {
  id: 'core/announcement_bar',
  name: 'announcement_bar',
  label: 'Announcement bar',
  icon: 'megaphone',
  category: 'layout',
  container: false,
  parts: [
    { name: 'text', label: 'Text', selector: '.block-announcement-text', target: 'text' },
    { name: 'link', label: 'Link', selector: '.block-announcement-link', target: 'text' },
  ],
  schema: [
    { name: 'style_id', type: 'style', label: 'Style', style_target: 'container', editor_group: 'content' },
    { name: 'text', type: 'richtext', label: 'Message', required: true },
    { name: 'link_label', type: 'text', label: 'Link text', default: 'Learn more', ui_text: 'learn_more' },
    { name: 'link_url', type: 'url', label: 'Link' },
    { name: 'tone', type: 'select', label: 'Colors', options: ['primary', 'neutral', 'dark'], option_labels: ['Primary color', 'Surface', 'Dark'], default: 'primary' },
    { name: 'align', type: 'select', label: 'Alignment', options: ['center', 'start'], default: 'center' },
    { name: 'dismissible', type: 'boolean', label: 'Visitors can close it', default: true, help: 'A closed message stays closed in that browser until its text or link changes.' },
  ],
  template: `<aside data-block="announcement_bar" data-tone="{{tone}}" data-align="{{align}}" aria-label="{{announcement_label}}"><div class="block-announcement-inner"><div class="block-announcement-text">{{{text}}}</div>{{#link_url}}<a class="block-announcement-link" href="{{link_url}}">{{link_label}}</a>{{/link_url}}</div>{{#dismissible}}<button type="button" class="block-announcement-close" aria-label="{{close_label}}" hidden>${CLOSE_ICON}</button>{{/dismissible}}</aside>`,
  styles: `
.page-content--blocks > [data-block="announcement_bar"][data-tone][data-align] { max-width:none; margin-inline:0; }
[data-block="announcement_bar"] { position:relative; padding:.625rem var(--content-gutter, 1.25rem); font-size:.9375rem; line-height:1.45; background:var(--color-primary, #111); color:var(--color-primary-fg, #fff); }
[data-block="announcement_bar"][data-tone="neutral"] { background:var(--color-surface, #f4f4f5); color:var(--color-text, #111); }
[data-block="announcement_bar"][data-tone="dark"] { background:#111318; color:#fff; }
[data-block="announcement_bar"]:has(.block-announcement-close:not([hidden])) { padding-inline-end:var(--announcement-close-space, 3rem); }
[data-block="announcement_bar"] .block-announcement-inner { display:flex; flex-wrap:wrap; align-items:baseline; justify-content:center; gap:var(--announcement-gap, .25rem .75rem); max-inline-size:var(--content-wide, 80rem); margin-inline:auto; }
[data-block="announcement_bar"][data-align="start"] .block-announcement-inner { justify-content:flex-start; }
[data-block="announcement_bar"] .block-announcement-text > * { margin:0; }
[data-block="announcement_bar"] .block-announcement-link { display:inline-block; padding-block:.25rem; color:inherit; font-weight:600; text-decoration:underline; text-underline-offset:.2em; }
[data-block="announcement_bar"] .block-announcement-close { position:absolute; inset-block-start:50%; inset-inline-end:.5rem; translate:0 -50%; display:inline-grid; place-items:center; inline-size:2rem; block-size:2rem; padding:0; border:0; border-radius:var(--announcement-close-radius, 999px); background:transparent; color:inherit; cursor:pointer; }
[data-block="announcement_bar"] .block-announcement-close:hover { background:var(--announcement-close-hover, rgb(127 127 127 / .2)); }
[data-block="announcement_bar"] .block-announcement-close:focus-visible { outline:2px solid currentColor; outline-offset:1px; }
[data-block="announcement_bar"] .block-announcement-close[hidden] { display:none; }
`.trim(),
  script: `${RUNTIME_GUARD}
window.TyperollBlocks.register('core/announcement_bar', function (el) {
  var close = el.querySelector('.block-announcement-close');
  if (!close) return;
  var key = 'typeroll:announcement:' + (el.getAttribute('data-dismiss-key') || '');
  try { if (localStorage.getItem(key)) { el.hidden = true; return; } } catch (e) {}
  close.hidden = false;
  close.addEventListener('click', function () {
    try { localStorage.setItem(key, '1'); } catch (e) {}
    el.hidden = true;
  });
});`,
  origin: 'core',
  created_at: ISO_EPOCH,
};

const scrollSteps: BlockType = {
  id: 'core/scroll_steps',
  name: 'scroll_steps',
  label: 'Scroll steps',
  icon: 'list-video',
  category: 'content',
  container: false,
  parts: [
    { name: 'title', label: 'Step title', selector: '.block-steps-title', target: 'heading' },
    { name: 'text', label: 'Step text', selector: '.block-steps-text', target: 'text' },
    { name: 'media', label: 'Picture', selector: '.block-steps-media', target: 'container', decorative: true },
  ],
  schema: [
    { name: 'style_id', type: 'style', label: 'Style', style_target: 'container', editor_group: 'content' },
    { name: 'items', type: 'array', label: 'Steps', fields: [
      { name: 'title', type: 'text', label: 'Title' },
      { name: 'text', type: 'richtext', label: 'Text' },
      { name: 'image', type: 'image', label: 'Picture for this step' },
      { name: 'image_alt', type: 'text', label: 'Picture description' },
    ] },
    { name: 'media_side', type: 'select', label: 'Picture side on wide screens', options: ['end', 'start'], option_labels: ['After the text', 'Before the text'], default: 'end' },
    { name: 'media_aspect', type: 'select', label: 'Picture shape', options: ['4:3', '1:1', '3:4', '16:9'], default: '4:3' },
    { name: 'media_fit', type: 'select', label: 'Picture fit', options: ['cover', 'contain'], default: 'cover' },
  ],
  template: `<div data-block="scroll_steps" data-side="{{media_side}}" data-aspect="{{media_aspect}}" data-fit="{{media_fit}}"><div class="block-steps-layout"><div class="block-steps-media" aria-hidden="true">{{#each items}}{{#image}}<img class="block-steps-frame" src="{{image}}" alt="" loading="lazy" decoding="async" data-step="{{@index}}" />{{/image}}{{/each}}</div><ol class="block-steps-list">{{#each items}}<li class="block-steps-step" data-step="{{@index}}">{{#image}}<img class="block-steps-step-media" src="{{image}}" alt="{{image_alt}}" loading="lazy" decoding="async" />{{/image}}<div class="block-steps-step-body">{{#title}}<h3 class="block-steps-title">{{title}}</h3>{{/title}}<div class="block-steps-text">{{{text}}}</div></div></li>{{/each}}</ol></div></div>`,
  styles: `
[data-block="scroll_steps"] { container-type:inline-size; --steps-ratio:4/3; }
[data-block="scroll_steps"][data-aspect="1:1"] { --steps-ratio:1; }
[data-block="scroll_steps"][data-aspect="3:4"] { --steps-ratio:3/4; }
[data-block="scroll_steps"][data-aspect="16:9"] { --steps-ratio:16/9; }
/* Without script, and in narrow columns, each step shows its own picture above the text. */
[data-block="scroll_steps"] .block-steps-media { display:none; }
[data-block="scroll_steps"] .block-steps-list { display:grid; gap:var(--steps-gap, 2.5rem); margin:0; padding:0; list-style:none; }
[data-block="scroll_steps"] .block-steps-step-media { display:block; inline-size:100%; block-size:auto; aspect-ratio:var(--steps-ratio); object-fit:cover; margin-block-end:var(--steps-media-space, 1rem); border-radius:var(--steps-radius, .75rem); }
[data-block="scroll_steps"][data-fit="contain"] .block-steps-step-media { object-fit:contain; background:var(--color-surface, #f4f4f5); }
[data-block="scroll_steps"] .block-steps-title { margin:0 0 .5rem; font-size:var(--type-h3, 1.5rem); line-height:1.25; }
[data-block="scroll_steps"] .block-steps-text > :first-child { margin-block-start:0; }
[data-block="scroll_steps"] .block-steps-text > :last-child { margin-block-end:0; }
@container (min-width: 52rem) {
  [data-block="scroll_steps"][data-enhanced] .block-steps-layout { display:grid; grid-template-columns:minmax(0, 1.15fr) minmax(0, 1fr); gap:var(--steps-columns-gap, clamp(2rem, 5cqi, 5rem)); align-items:start; }
  [data-block="scroll_steps"][data-enhanced][data-side="start"] .block-steps-media { order:-1; }
  [data-block="scroll_steps"][data-enhanced][data-side="end"] .block-steps-list { grid-row:1; grid-column:1; }
  [data-block="scroll_steps"][data-enhanced] .block-steps-media { display:block; position:sticky; inset-block-start:calc(var(--steps-top, 0px) + max(1.5rem, (100svh - var(--steps-top, 0px) - min(70svh, 40rem)) / 2)); aspect-ratio:var(--steps-ratio); max-block-size:70svh; inline-size:100%; overflow:hidden; border-radius:.75rem; background:var(--color-surface, #f4f4f5); }
  [data-block="scroll_steps"][data-enhanced] .block-steps-frame { position:absolute; inset:0; inline-size:100%; block-size:100%; object-fit:cover; opacity:0; transition:opacity .5s ease; }
  [data-block="scroll_steps"][data-enhanced][data-fit="contain"] .block-steps-frame { object-fit:contain; }
  [data-block="scroll_steps"][data-enhanced] .block-steps-frame[data-active] { opacity:var(--steps-frame-active, 1); }
  [data-block="scroll_steps"][data-enhanced] .block-steps-list { gap:0; }
  [data-block="scroll_steps"][data-enhanced] .block-steps-step { display:flex; align-items:center; min-block-size:70svh; opacity:var(--steps-inactive, .4); transition:opacity .4s ease; }
  [data-block="scroll_steps"][data-enhanced] .block-steps-step[data-active] { opacity:var(--steps-active, 1); }
  /* The last step only needs to reach the middle of the screen, not leave a screen of space below it. */
  [data-block="scroll_steps"][data-enhanced] .block-steps-step:last-child { min-block-size:50svh; }
  [data-block="scroll_steps"][data-enhanced] .block-steps-step-media { display:none; }
}
@media (prefers-reduced-motion: reduce) { [data-block="scroll_steps"] :is(.block-steps-frame, .block-steps-step) { transition:none !important; } }
`.trim(),
  script: `${RUNTIME_GUARD}
window.TyperollBlocks.register('core/scroll_steps', function (el) {
  if (!('IntersectionObserver' in window)) return;
  var steps = [].slice.call(el.querySelectorAll('.block-steps-step'));
  var frames = [].slice.call(el.querySelectorAll('.block-steps-frame'));
  if (!steps.length) return;
  el.setAttribute('data-enhanced', '');
  var root = document.documentElement, current = -1;
  function top() { el.style.setProperty('--steps-top', (parseFloat(root.getAttribute('data-tr-header-clearance')) || 0) + 'px'); }
  function activate(index) {
    if (index === current) return;
    current = index;
    steps.forEach(function (step, i) { if (i === index) step.setAttribute('data-active', ''); else step.removeAttribute('data-active'); });
    // A step without a picture keeps the picture of the step before it.
    var frame = null;
    frames.forEach(function (f) { if (Number(f.getAttribute('data-step')) <= index) frame = f; });
    frames.forEach(function (f) { if (f === (frame || frames[0])) f.setAttribute('data-active', ''); else f.removeAttribute('data-active'); });
    el.dispatchEvent(new CustomEvent('typeroll:step-change', { bubbles: true, detail: { index: index } }));
  }
  var observer = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) { if (entry.isIntersecting) activate(steps.indexOf(entry.target)); });
  }, { rootMargin: '-45% 0px -45% 0px' });
  steps.forEach(function (step) { observer.observe(step); });
  window.addEventListener('typeroll:header-clearance', top);
  top();
  activate(0);
});`,
  origin: 'core',
  created_at: ISO_EPOCH,
};

const scrollFilm: BlockType = {
  id: 'core/scroll_film',
  name: 'scroll_film',
  label: 'Scroll film',
  icon: 'film',
  category: 'media',
  container: false,
  parts: [
    { name: 'caption', label: 'Caption', selector: '.block-film-caption', target: 'text' },
  ],
  schema: [
    { name: 'frames_pattern', type: 'text', label: 'Frame address pattern', placeholder: '/media/film/frame-{nnnn}.webp',
      help: 'The address of every frame, with {n} for the frame number; {nnnn} pads it to four digits. Frames scale best as WebP or AVIF, 1600–2000 px wide.' },
    { name: 'frame_count', type: 'number', label: 'Number of frames', min: 2, max: 600 },
    { name: 'frame_first', type: 'number', label: 'First frame number', default: 1, min: 0, max: 100000 },
    { name: 'frames_pattern_phone', type: 'text', label: 'Frame address pattern on phones (optional)', placeholder: '/media/film/phone-{nnnn}.webp',
      help: 'Smaller or upright frames for phones, with the same number of frames.' },
    { name: 'frames', type: 'array', label: 'Frames (instead of a pattern)', fields: [{ name: 'src', type: 'image', label: 'Frame' }] },
    { name: 'frames_phone', type: 'array', label: 'Phone frames (instead of a phone pattern)', help: 'Upright or smaller frames for phones, usually as many as the frames above.', fields: [{ name: 'src', type: 'image', label: 'Frame' }] },
    { name: 'video', type: 'url', label: 'Video file (instead of frames)',
      help: 'Plays as the page scrolls. It is smoothest when the video has a keyframe on every frame; frames are smoother still.' },
    { name: 'poster', type: 'image', label: 'Still image', help: 'Shown before the film loads, without script and for reduced motion. Defaults to the first frame.' },
    { name: 'description', type: 'text', label: 'What the film shows', help: 'Read by screen readers.' },
    { name: 'length', type: 'select', label: 'Scroll length', options: ['short', 'medium', 'long'], option_labels: ['Short (2½ screens)', 'Medium (4 screens)', 'Long (6 screens)'], default: 'medium' },
    { name: 'fit', type: 'select', label: 'Fit', options: ['cover', 'contain'], default: 'cover' },
    { name: 'background', type: 'color', label: 'Background color' },
    { name: 'captions', type: 'array', label: 'Captions', fields: [
      { name: 'text', type: 'richtext', label: 'Text' },
      { name: 'start', type: 'number', label: 'Show from (% of the film)', min: 0, max: 100 },
      { name: 'end', type: 'number', label: 'Show until (% of the film)', min: 0, max: 100 },
      { name: 'position', type: 'select', label: 'Vertical position', options: ['end', 'center', 'start'], default: 'end' },
      { name: 'align', type: 'select', label: 'Horizontal position', options: ['start', 'center', 'end'], default: 'start' },
    ] },
  ],
  template: `<section data-block="scroll_film" data-length="{{length}}" data-fit="{{fit}}" style="--film-bg:{{film_bg}}"><div class="block-film-stage"><img class="block-film-poster" src="{{poster_src}}" alt="{{description}}" loading="lazy" decoding="async" /><div class="block-film-captions">{{#each captions}}<div class="block-film-caption" data-start="{{start}}" data-end="{{end}}" data-position="{{position}}" data-align="{{align}}">{{{text}}}</div>{{/each}}</div></div></section>`,
  styles: `
/* A film placed directly in the page runs edge to edge, like a section. */
.page-content--blocks > [data-block="scroll_film"][data-length][data-fit] { max-width:none; margin-inline:0; padding-inline:0; }
[data-block="scroll_film"] { --film-length:4; position:relative; background:var(--film-bg); color:var(--film-fg, #fff); --color-text:#fff; --color-text-light:rgb(255 255 255 / .8); }
[data-block="scroll_film"][data-length="short"] { --film-length:2.5; }
[data-block="scroll_film"][data-length="long"] { --film-length:6; }
/* The still version: the image, then the captions in order. */
[data-block="scroll_film"] .block-film-poster { display:block; inline-size:100%; block-size:auto; }
[data-block="scroll_film"] .block-film-captions { display:grid; gap:var(--film-caption-gap, 1.25rem); max-inline-size:var(--content-normal, 65rem); margin-inline:auto; padding:2rem var(--content-gutter, 1.25rem); }
[data-block="scroll_film"] .block-film-caption > :first-child { margin-block-start:0; }
[data-block="scroll_film"] .block-film-caption > :last-child { margin-block-end:0; }
[data-block="scroll_film"][data-film-ready] { block-size:calc(var(--film-length) * (100svh - var(--film-top, 0px))); }
[data-block="scroll_film"][data-film-ready] .block-film-stage { position:sticky; inset-block-start:var(--film-top, 0px); block-size:calc(100svh - var(--film-top, 0px)); overflow:hidden; }
[data-block="scroll_film"][data-film-ready] :is(.block-film-poster, .block-film-canvas) { position:absolute; inset:0; inline-size:100%; block-size:100%; object-fit:cover; }
[data-block="scroll_film"][data-film-ready][data-fit="contain"] :is(.block-film-poster, .block-film-canvas) { object-fit:contain; }
[data-block="scroll_film"][data-film-drawn] .block-film-poster { opacity:0; }
[data-block="scroll_film"][data-film-ready] .block-film-captions { position:absolute; inset:0; grid-template-columns:minmax(0, 1fr); max-inline-size:var(--content-wide, 80rem); padding:clamp(1.5rem, 6vh, 4rem) var(--content-gutter, 1.25rem); pointer-events:none; }
[data-block="scroll_film"][data-film-ready] .block-film-caption { grid-area:1/1; align-self:end; justify-self:start; max-inline-size:min(100%, 34rem); padding:1rem 1.25rem; border-radius:.75rem; background:rgb(0 0 0 / .5); -webkit-backdrop-filter:blur(8px); backdrop-filter:blur(8px); font-size:var(--type-lead, 1.125rem); line-height:1.5; opacity:0; translate:0 1rem; }
[data-block="scroll_film"][data-film-live] .block-film-caption { transition:opacity .4s ease, translate .4s ease; }
[data-block="scroll_film"][data-film-ready] .block-film-caption[data-visible] { opacity:1; translate:none; }
[data-block="scroll_film"][data-film-ready] .block-film-caption[data-position="start"] { align-self:start; }
[data-block="scroll_film"][data-film-ready] .block-film-caption[data-position="center"] { align-self:center; }
[data-block="scroll_film"][data-film-ready] .block-film-caption[data-align="center"] { justify-self:center; text-align:center; }
[data-block="scroll_film"][data-film-ready] .block-film-caption[data-align="end"] { justify-self:end; }
`.trim(),
  script: `${RUNTIME_GUARD}
window.TyperollBlocks.register('core/scroll_film', function (el) {
  if (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  var stage = el.querySelector(':scope > .block-film-stage');
  if (!stage) return;
  var phone = window.matchMedia && matchMedia('(max-width: 767px)').matches;
  var frames = [];
  try { frames = JSON.parse(el.getAttribute('data-film-frames') || '[]'); } catch (e) { frames = []; }
  try { var phoneFrames = JSON.parse(el.getAttribute('data-film-frames-phone') || '[]'); if (phone && phoneFrames.length >= 2) frames = phoneFrames; } catch (e) {}
  var pattern = (phone && el.getAttribute('data-film-pattern-phone')) || el.getAttribute('data-film-pattern');
  var count = Number(el.getAttribute('data-film-count')), first = Number(el.getAttribute('data-film-first')) || 0;
  if (!frames.length && pattern && count > 1) {
    for (var n = 0; n < count; n++) frames.push(pattern.replace(/\\{(n+)\\}/, function (_, pad) { var s = String(first + n); while (s.length < pad.length) s = '0' + s; return s; }));
  }
  var videoSrc = el.getAttribute('data-film-video');
  if (frames.length < 2 && !videoSrc) return;
  el.setAttribute('data-film-ready', '');
  var root = document.documentElement;
  var captions = [].slice.call(el.querySelectorAll('.block-film-caption'));
  var progress = 0, scheduled = false, started = false, frame = 0, draw, start;
  var poster = stage.querySelector('.block-film-poster');
  if (frames.length >= 2) {
    var canvas = document.createElement('canvas');
    canvas.className = 'block-film-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    poster.insertAdjacentElement('afterend', canvas);
    var context = canvas.getContext('2d'), images = [], last = -1;
    var contain = el.getAttribute('data-fit') === 'contain';
    var paint = function (i) {
      var img = images[i], cw = canvas.width, ch = canvas.height;
      var scale = contain ? Math.min(cw / img.naturalWidth, ch / img.naturalHeight) : Math.max(cw / img.naturalWidth, ch / img.naturalHeight);
      var w = img.naturalWidth * scale, h = img.naturalHeight * scale;
      context.clearRect(0, 0, cw, ch);
      context.drawImage(img, (cw - w) / 2, (ch - h) / 2, w, h);
    };
    var nearest = function (target) {
      for (var k = 0; k < frames.length; k++) { if (images[target - k]) return target - k; if (images[target + k]) return target + k; }
      return -1;
    };
    draw = function (force) {
      frame = Math.round(progress * (frames.length - 1));
      var i = nearest(frame);
      if (i < 0 || (i === last && !force)) return;
      last = i; paint(i); el.setAttribute('data-film-drawn', '');
    };
    var size = function () {
      var rect = stage.getBoundingClientRect(), ratio = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.max(1, Math.round(rect.width * ratio)); canvas.height = Math.max(1, Math.round(rect.height * ratio));
      draw(true);
    };
    // Coarse frames first, then finer, so scrolling shows motion before everything has loaded.
    var order = [], seen = {};
    [32, 16, 8, 4, 2, 1].forEach(function (step) { for (var j = 0; j < frames.length; j += step) if (!seen[j]) { seen[j] = true; order.push(j); } });
    if (!seen[frames.length - 1]) order.splice(1, 0, frames.length - 1);
    var active = 0, next = 0;
    var pump = function () {
      while (active < 6 && next < order.length) (function (i) {
        active++;
        var img = new Image();
        img.decoding = 'async';
        img.onload = function () { images[i] = img; active--; if (last < 0 || Math.abs(i - frame) <= 32) draw(); pump(); };
        img.onerror = function () { active--; pump(); };
        img.src = frames[i];
      })(order[next++]);
    };
    start = function () { pump(); size(); };
    if (typeof ResizeObserver === 'function') new ResizeObserver(function () { if (started) size(); }).observe(stage);
  } else {
    var video = document.createElement('video');
    video.className = 'block-film-canvas';
    video.muted = true; video.playsInline = true; video.preload = 'auto';
    video.setAttribute('aria-hidden', 'true');
    poster.insertAdjacentElement('afterend', video);
    var seeking = false, want = 0;
    var seek = function () { if (!video.duration || seeking) return; seeking = true; video.currentTime = want; };
    video.addEventListener('seeked', function () { seeking = false; el.setAttribute('data-film-drawn', ''); if (Math.abs(video.currentTime - want) > 0.04) seek(); });
    video.addEventListener('loadedmetadata', function () { draw(); });
    draw = function () { if (!video.duration) return; want = progress * Math.max(0, video.duration - 0.05); frame = want; seek(); };
    start = function () { video.src = videoSrc; };
  }
  function update() {
    scheduled = false;
    var rect = el.getBoundingClientRect(), span = rect.height - stage.offsetHeight;
    progress = span > 0 ? Math.min(1, Math.max(0, -rect.top / span)) : 0;
    el.style.setProperty('--film-progress', progress.toFixed(4));
    var percent = progress * 100, shown = {};
    // One caption at a time in each place: the one that started last.
    captions.forEach(function (caption) {
      var from = parseFloat(caption.getAttribute('data-start')), to = parseFloat(caption.getAttribute('data-end'));
      if (!isFinite(from)) from = 0; if (!isFinite(to)) to = 100;
      var place = caption.getAttribute('data-position') || 'end';
      if (percent >= from && percent <= to && (!shown[place] || from >= shown[place].from)) shown[place] = { caption: caption, from: from };
    });
    captions.forEach(function (caption) {
      var place = caption.getAttribute('data-position') || 'end';
      if (shown[place] && shown[place].caption === caption) caption.setAttribute('data-visible', ''); else caption.removeAttribute('data-visible');
    });
    if (started) draw();
    el.dispatchEvent(new CustomEvent('typeroll:film-progress', { detail: { progress: progress, frame: frame } }));
    // Captions fade only after the first placement, so the film never starts mid-fade.
    if (!el.hasAttribute('data-film-live')) requestAnimationFrame(function () { el.setAttribute('data-film-live', ''); });
  }
  function schedule() { if (!scheduled) { scheduled = true; requestAnimationFrame(update); } }
  function top() { el.style.setProperty('--film-top', (parseFloat(root.getAttribute('data-tr-header-clearance')) || 0) + 'px'); }
  // Frames load only when the film comes near the screen.
  var near = new IntersectionObserver(function (entries) {
    if (!entries[0].isIntersecting || started) return;
    started = true; near.disconnect(); start(); schedule();
  }, { rootMargin: '100% 0px' });
  near.observe(el);
  window.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('resize', schedule);
  window.addEventListener('typeroll:header-clearance', function () { top(); schedule(); });
  top();
  update();
});`,
  origin: 'core',
  created_at: ISO_EPOCH,
};

const svgAnimation: BlockType = {
  id: 'core/svg_animation',
  name: 'svg_animation',
  label: 'SVG animation',
  icon: 'pen-tool',
  category: 'media',
  container: false,
  parts: [
    { name: 'caption', label: 'Caption', selector: '.block-svg-caption', target: 'text' },
    { name: 'stage', label: 'Drawing', selector: '.block-svg-stage', target: 'container', decorative: true },
  ],
  schema: [
    { name: 'svg', type: 'textarea', label: 'SVG markup', required: true,
      help: 'Paste an <svg> drawing. Lines (stroke) can be drawn; shapes and groups can appear in turn. Scripts and event attributes are removed.' },
    { name: 'label', type: 'text', label: 'What the drawing shows', help: 'Read by screen readers. Leave empty for a decorative drawing.' },
    { name: 'caption', type: 'text', label: 'Caption' },
    { name: 'trigger', type: 'select', label: 'Starts', options: ['enter', 'enter_every', 'load', 'position', 'scroll', 'loop'],
      option_labels: ['When it scrolls into view', 'Every time it scrolls into view', 'When the page opens', 'When it reaches a position on the screen', 'Follows the scrolling', 'Loops'], default: 'enter' },
    { name: 'effect', type: 'select', label: 'Effect', options: ['draw', 'draw_sequence', 'reveal', 'custom'],
      option_labels: ['Draw all lines together', 'Draw the lines one after another', 'Show the parts one after another', 'Custom (site CSS reads --svg-progress)'], default: 'draw' },
    { name: 'position', type: 'number', label: 'Screen position (% from the top)', default: 60, min: 0, max: 100,
      help: 'For "reaches a position": where the top of the drawing starts it. For "follows the scrolling": where the drawing is finished.' },
    { name: 'duration', type: 'number', label: 'Duration (seconds)', default: 2, min: 0.2, max: 20 },
    { name: 'loop_pause', type: 'number', label: 'Pause between loops (seconds)', default: 1, min: 0, max: 30 },
    { name: 'size', type: 'select', label: 'Size', options: ['small', 'medium', 'large', 'full'], default: 'medium' },
    { name: 'align', type: 'select', label: 'Alignment', options: ['center', 'start'], default: 'center' },
  ],
  template: `<figure data-block="svg_animation" data-trigger="{{trigger}}" data-effect="{{effect}}" data-size="{{size}}" data-align="{{align}}" data-position="{{position}}" data-duration="{{duration}}" data-loop-pause="{{loop_pause}}" data-static="{{svg_static}}" data-label-pause="{{pause_label}}" data-label-play="{{play_label}}"><div class="block-svg-stage" {{{svg_a11y}}}>{{{svg}}}</div>{{#caption}}<figcaption class="block-svg-caption">{{caption}}</figcaption>{{/caption}}</figure>`,
  styles: `
[data-block="svg_animation"] { --svg-width:28rem; margin:0; }
[data-block="svg_animation"][data-size="small"] { --svg-width:16rem; }
[data-block="svg_animation"][data-size="large"] { --svg-width:44rem; }
[data-block="svg_animation"][data-size="full"] { --svg-width:100%; }
[data-block="svg_animation"] .block-svg-stage { position:relative; max-inline-size:min(100%, var(--svg-width)); margin-inline:auto; }
[data-block="svg_animation"][data-align="start"] .block-svg-stage { margin-inline:0; }
[data-block="svg_animation"] .block-svg-stage > svg { display:block; inline-size:100%; block-size:auto; overflow:visible; }
[data-block="svg_animation"] .block-svg-caption { margin-block-start:var(--svg-caption-space, .75rem); text-align:center; font-size:var(--svg-caption-size, .9375rem); color:var(--color-text-light, #64748b); }
[data-block="svg_animation"][data-align="start"] .block-svg-caption { text-align:start; }
[data-block="svg_animation"] .block-svg-toggle { position:absolute; inset-block-end:0; inset-inline-end:0; display:inline-grid; place-items:center; inline-size:2.25rem; block-size:2.25rem; padding:0; border:0; border-radius:var(--svg-toggle-radius, 999px); background:var(--svg-toggle-bg, var(--color-surface, #f4f4f5)); color:var(--color-text, #111); cursor:pointer; }
[data-block="svg_animation"] .block-svg-toggle:focus-visible { outline:2px solid currentColor; outline-offset:2px; }
`.trim(),
  script: `${RUNTIME_GUARD}
window.TyperollBlocks.register('core/svg_animation', function (el) {
  var svg = el.querySelector('.block-svg-stage > svg');
  if (!svg || el.getAttribute('data-static') === 'true') return;
  if (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  var trigger = el.getAttribute('data-trigger') || 'enter', effect = el.getAttribute('data-effect') || 'draw';
  var duration = Math.max(200, (parseFloat(el.getAttribute('data-duration')) || 2) * 1000);
  var line = Math.min(100, Math.max(0, parseFloat(el.getAttribute('data-position')))) ; if (!isFinite(line)) line = 60;
  var hold = Math.max(0, (parseFloat(el.getAttribute('data-loop-pause')) || 0) * 1000);
  var SHAPES = 'path,line,polyline,polygon,circle,ellipse,rect';
  var strokes = [].filter.call(svg.querySelectorAll(SHAPES), function (shape) {
    var stroke = getComputedStyle(shape).stroke;
    return stroke && stroke !== 'none' && typeof shape.getTotalLength === 'function';
  }).map(function (shape) { var length = 0; try { length = shape.getTotalLength(); } catch (e) {} return { shape: shape, length: length }; })
    .filter(function (item) { return item.length > 0; });
  var parts = [].filter.call(svg.children, function (child) { return !/^(defs|title|desc|style|metadata)$/i.test(child.tagName); });
  if (effect !== 'custom' && !(effect === 'reveal' ? parts.length : strokes.length)) return;
  var progress = -1;
  function clamp(value) { return Math.min(1, Math.max(0, value)); }
  function render(p) {
    p = clamp(p);
    if (p === progress) return;
    progress = p;
    el.style.setProperty('--svg-progress', p.toFixed(4));
    if (effect === 'draw' || effect === 'draw_sequence') {
      strokes.forEach(function (item, i) {
        var local = effect === 'draw' ? p : clamp(p * strokes.length - i);
        item.shape.style.strokeDasharray = item.length + ' ' + item.length;
        item.shape.style.strokeDashoffset = String(item.length * (1 - local));
      });
    } else if (effect === 'reveal') {
      parts.forEach(function (part, i) {
        var local = clamp(p * parts.length - i);
        part.style.opacity = String(local);
        part.style.transform = 'translateY(' + ((1 - local) * 8) + 'px)';
      });
    }
    el.setAttribute('data-svg-state', p >= 1 ? 'done' : p > 0 ? 'running' : 'idle');
    el.dispatchEvent(new CustomEvent('typeroll:svg-progress', { bubbles: true, detail: { progress: p } }));
  }
  var frame = 0, paused = false;
  function ease(t) { return t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }
  function play(onDone) {
    cancelAnimationFrame(frame);
    var start = performance.now();
    (function tick(now) {
      if (paused) { start = now - progress * duration; frame = requestAnimationFrame(tick); return; }
      var t = clamp((now - start) / duration);
      render(ease(t));
      if (t < 1) frame = requestAnimationFrame(tick); else if (onDone) onDone();
    })(start);
  }
  render(0);
  if (trigger === 'scroll') {
    var scheduled = false;
    var update = function () {
      scheduled = false;
      var rect = el.getBoundingClientRect(), height = window.innerHeight;
      var from = height, to = height * line / 100;
      render(from === to ? 1 : (from - rect.top) / (from - to));
    };
    var schedule = function () { if (!scheduled) { scheduled = true; requestAnimationFrame(update); } };
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    update();
    return;
  }
  if (trigger === 'load') { play(); return; }
  if (!('IntersectionObserver' in window)) { render(1); return; }
  if (trigger === 'loop') {
    var visible = false, timer = 0;
    var cycle = function () { if (!visible || paused) return; render(0); play(function () { timer = setTimeout(cycle, hold); }); };
    var toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'block-svg-toggle';
    var label = function () { toggle.setAttribute('aria-label', paused ? el.getAttribute('data-label-play') : el.getAttribute('data-label-pause')); toggle.textContent = paused ? '\\u25B6' : '\\u275A\\u275A'; };
    toggle.addEventListener('click', function () { paused = !paused; label(); if (!paused && progress >= 1) { clearTimeout(timer); cycle(); } });
    label();
    el.querySelector('.block-svg-stage').appendChild(toggle);
    new IntersectionObserver(function (entries) {
      visible = entries[0].isIntersecting;
      clearTimeout(timer);
      if (visible) cycle(); else cancelAnimationFrame(frame);
    }).observe(el);
    return;
  }
  var margin = trigger === 'position' ? '0px 0px -' + (100 - line) + '% 0px' : '0px 0px -10% 0px';
  var observer = new IntersectionObserver(function (entries) {
    var entry = entries[0];
    if (entry.isIntersecting) { play(); if (trigger !== 'enter_every') observer.disconnect(); }
    else if (trigger === 'enter_every' && entry.boundingClientRect.top > 0) { cancelAnimationFrame(frame); render(0); }
  }, { rootMargin: margin });
  observer.observe(el);
});`,
  origin: 'core',
  created_at: ISO_EPOCH,
};

export const STORY_BLOCK_TYPES: BlockType[] = [stats, timeline, audio, beforeAfter, announcementBar, scrollSteps, scrollFilm, svgAnimation];

const STORY_BLOCK_IDS = new Set(STORY_BLOCK_TYPES.map(type => type.id));
const FRAME_PATTERN = /\{(n+)\}/;

/** Frame addresses from a pattern, or none when the pattern or count is unusable. */
export function scrollFilmFrames(pattern: unknown, count: unknown, first: unknown): string[] {
  const text = String(pattern ?? '').trim();
  const total = Number(count);
  if (!FRAME_PATTERN.test(text) || !Number.isInteger(total) || total < 2 || total > 600) return [];
  const start = Number.isInteger(Number(first)) ? Number(first) : 1;
  const frames = Array.from({ length: total }, (_, n) => text.replace(FRAME_PATTERN, (_m, pad: string) => String(start + n).padStart(pad.length, '0')));
  return frames.every(frame => mediaAddress(frame)) ? frames : [];
}

/** djb2 hash of a string, as base 36: a stable key that changes with the message. */
function shortHash(value: string): string {
  let hash = 5381;
  for (let i = 0; i < value.length; i++) hash = ((hash << 5) + hash + value.charCodeAt(i)) >>> 0;
  return hash.toString(36);
}

/**
 * Derived template values and root attributes for the story blocks.
 * `reduced` is the site's `motion: "reduced"` at render version 14.
 */
export function prepareStoryBlock(blockType: BlockType, data: Record<string, unknown>, options: { language: unknown; reduced: boolean }): Record<string, string> {
  const type = blockType.id;
  if (!STORY_BLOCK_IDS.has(type)) return {};
  // Inside a loop a name missing on the item falls back to the block; an item
  // field is never read from the block.
  const own = new Set(blockType.schema.map(field => field.name));
  for (const field of blockType.schema) {
    if (field.type !== 'array') continue;
    for (const sub of field.fields ?? []) if (!own.has(sub.name)) delete data[sub.name];
    // Item fields left unset take their defaults, as block fields do.
    const defaults = (field.fields ?? []).filter(sub => sub.default !== undefined);
    if (defaults.length && Array.isArray(data[field.name])) {
      data[field.name] = (data[field.name] as unknown[]).map(item => item && typeof item === 'object'
        ? { ...Object.fromEntries(defaults.map(sub => [sub.name, sub.default])), ...Object.fromEntries(Object.entries(item).filter(([, value]) => value !== undefined && value !== '')) }
        : item);
    }
  }
  if (type === 'core/stats' && options.reduced) data.count_up = false;
  if (type === 'core/svg_animation') {
    data.svg_static = options.reduced ? 'true' : 'false';
    data.pause_label = uiLabel(options.language, 'pause_animation');
    data.play_label = uiLabel(options.language, 'play_animation');
    const label = String(data.label ?? '').trim();
    data.svg_a11y = label ? `role="img" aria-label="${label.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!)}"` : 'aria-hidden="true"';
  }
  if (type === 'core/announcement_bar') {
    data.announcement_label = uiLabel(options.language, 'announcement');
    data.close_label = uiLabel(options.language, 'close');
    return { 'data-dismiss-key': shortHash(`${String(data.text ?? '')}\u0000${String(data.link_url ?? '')}`) };
  }
  if (type === 'core/scroll_film') {
    const list = Array.isArray(data.frames)
      ? data.frames.map(frame => mediaAddress(frame && typeof frame === 'object' ? (frame as { src?: unknown }).src : frame)).filter(Boolean)
      : [];
    const pattern = scrollFilmFrames(data.frames_pattern, data.frame_count, data.frame_first ?? 1);
    const video = videoFileAddress(data.video);
    data.poster_src = mediaAddress(data.poster) || list[0] || pattern[0] || '';
    const color = String(data.background ?? '').trim();
    data.film_bg = /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%/]+\)|hsla?\([\d\s.,%/deg]+\)|[a-z]+)$/i.test(color) ? color : 'var(--film-default-bg, #0b0b0d)';
    if (options.reduced) return {};
    if (list.length >= 2) {
      const phone = Array.isArray(data.frames_phone)
        ? data.frames_phone.map(frame => mediaAddress(frame && typeof frame === 'object' ? (frame as { src?: unknown }).src : frame)).filter(Boolean)
        : [];
      return { 'data-film-frames': JSON.stringify(list.slice(0, 600)), ...(phone.length ? { 'data-film-frames-phone': JSON.stringify(phone.slice(0, 600)) } : {}) };
    }
    if (pattern.length) {
      const attrs: Record<string, string> = {
        'data-film-pattern': String(data.frames_pattern).trim(),
        'data-film-count': String(pattern.length),
        'data-film-first': String(Number.isInteger(Number(data.frame_first)) ? Number(data.frame_first) : 1),
      };
      if (scrollFilmFrames(data.frames_pattern_phone, data.frame_count, data.frame_first ?? 1).length) attrs['data-film-pattern-phone'] = String(data.frames_pattern_phone).trim();
      return attrs;
    }
    if (video) return { 'data-film-video': video };
  }
  return {};
}
