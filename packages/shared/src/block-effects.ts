// Shared presentation effects from render version 14: entrance motion,
// background media behind sections, containers and calls to action, the
// gallery lightbox and the logo marquee.
//
// Each effect is a field on the block types that offer it. The renderer marks
// the block's root element (data-motion, data-bg-media, data-lightbox,
// data-layout="marquee"); one small runtime per effect enhances the marked
// elements. Content is complete and visible without script: the runtimes only
// hide something they are about to reveal, and only when the visitor allows
// motion. A site that sets `motion: "reduced"` renders no motion at all.
//
// Hooks for a site's own CSS and scripts (documented in the block reference):
// - custom properties: --motion-duration, --motion-easing, --motion-distance,
//   --motion-scale, --motion-stagger, --bg-overlay, --bg-overlay-color,
//   --marquee-duration, --marquee-gap;
// - attributes: [data-motion-in] once an element has entered,
//   motion "custom" for an animation written entirely in site CSS;
// - events: `typeroll:motion-in` (bubbles) on each element that enters.

import type { Block, BlockType, FieldDefinition } from './types.js';
import { mediaAddress, videoFileAddress, PAUSE_ICON, PLAY_ICON } from './block-media.js';
import { uiLabel } from './ui-text.js';

const escapeAttr = (value: unknown) =>
  String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);

export const MOTION_OPTIONS = ['none', 'fade', 'rise', 'scale', 'custom'] as const;
export type MotionOption = typeof MOTION_OPTIONS[number];

export const motionField: FieldDefinition = {
  name: 'motion',
  type: 'select',
  label: 'Entrance animation',
  options: [...MOTION_OPTIONS],
  option_labels: ['None', 'Fade in', 'Rise', 'Scale up', 'Custom (site CSS)'],
  default: 'none',
  min_render_version: 14,
  editor_group: 'appearance',
  help: 'Plays once when the block scrolls into view. Containers, grids and lists bring in their blocks one after another. Visitors who prefer reduced motion, and sites with reduced motion, see no animation. "Custom" only marks the moment with [data-motion-in] for an animation in your own CSS.',
};

/** Fields for media behind a block; `withImage` adds the image itself (the section has none yet). */
export function backgroundMediaFields(withImage: boolean): FieldDefinition[] {
  return [
    ...(withImage ? [
      { name: 'background_image', type: 'image', label: 'Background image', min_render_version: 14, editor_group: 'appearance' } as FieldDefinition,
      ...(['x', 'y'] as const).map((axis): FieldDefinition => ({
        name: `background_focal_${axis}`, label: `Background focal ${axis === 'x' ? 'horizontal' : 'vertical'} position (%)`,
        type: 'number', min: 0, max: 100, default: 50, min_render_version: 14, editor_group: 'appearance',
      })),
    ] : []),
    { name: 'background_video', type: 'url', label: 'Background video (MP4 or WebM file)', min_render_version: 14, editor_group: 'appearance',
      help: 'A muted, looping video file behind the content. It starts when the block is in view, has a pause button and never plays for visitors who prefer reduced motion. YouTube and Vimeo addresses are not used as backgrounds.' },
    { name: 'background_overlay', type: 'number', label: 'Background darkening (0-100)', min: 0, max: 100, default: 40, min_render_version: 14, editor_group: 'appearance',
      help: 'Darkens a background image or video so white text stays readable. 0 turns it off; then set a text color that suits the image.' },
    { name: 'background_video_phones', type: 'select', label: 'Background video on phones', options: ['poster', 'play'], option_labels: ['Show the image only', 'Play the video'], default: 'poster', min_render_version: 14, editor_group: 'appearance' },
  ];
}

/** Where text sits over media, as CSS for each of the nine places. */
const TEXT_PLACES = ['top-start', 'top-center', 'top-end', 'center-start', 'center', 'center-end', 'bottom-start', 'bottom-center', 'bottom-end'] as const;
const PLACE_LABELS = ['Top left', 'Top center', 'Top right', 'Middle left', 'Middle', 'Middle right', 'Bottom left', 'Bottom center', 'Bottom right'];
function placeCss(place: string): string {
  const [y, x] = place === 'center' ? ['center', 'center'] : place.split('-') as [string, string];
  const justify = { top: 'flex-start', center: 'center', bottom: 'flex-end' }[y]!;
  const margins = { start: 'var(--tr-edge) auto', center: 'auto', end: 'auto var(--tr-edge)' }[x]!;
  const spot = { start: '20%', center: '50%', end: '80%' }[x]!;
  const spotY = { top: '20%', center: '50%', bottom: '80%' }[y]!;
  return `--text-y:${justify};--text-margins:${margins};--spot-x:${spot};--spot-y:${spotY};--text-align:${x === 'center' ? 'center' : x};`;
}

export const OVERLAY_STYLES = ['solid', 'gradient', 'spot'] as const;
export const TEXT_PANELS = ['none', 'solid', 'dark_translucent', 'light_translucent', 'dark_glass', 'light_glass', 'band'] as const;
export const TEXT_PANEL_SHAPES = ['rounded', 'square', 'pill', 'blob', 'slant', 'custom'] as const;

/**
 * Readable text over an image or video: how the media darkens (evenly, from
 * one side or behind the text), a plate behind the text and its shape, and
 * for a section where the text sits, per screen size.
 */
export function textOverMediaFields(withPlacement: boolean): FieldDefinition[] {
  const v14 = { min_render_version: 14, editor_group: 'appearance' } as const;
  const fields: FieldDefinition[] = [
    { name: 'overlay_style', type: 'select', label: 'Darkening', options: [...OVERLAY_STYLES], option_labels: ['Even', 'From one side', 'Behind the text'], default: 'solid', ...v14,
      help: 'Even darkens the whole image; from one side fades from the chosen side; behind the text darkens a soft spot where the text is.' },
    { name: 'overlay_side', type: 'select', label: 'Darkest side', options: ['bottom', 'top', 'start', 'end'], option_labels: ['Bottom', 'Top', 'Left', 'Right'], default: 'bottom', ...v14 },
    { name: 'overlay_color', type: 'color', label: 'Darkening color', ...v14 },
    { name: 'text_panel', type: 'select', label: 'Plate behind the text', options: [...TEXT_PANELS],
      option_labels: ['None', 'Solid (page colors)', 'Dark, see-through', 'Light, see-through', 'Dark glass (blurs the image)', 'Light glass (blurs the image)', 'Full-width band'], default: 'none', ...v14 },
    { name: 'text_panel_shape', type: 'select', label: 'Plate shape', options: [...TEXT_PANEL_SHAPES],
      option_labels: ['Rounded', 'Square', 'Pill', 'Organic', 'Slanted edge', 'Custom (--panel-clip and --panel-radius in site CSS)'], default: 'rounded', ...v14 },
    ...(withPlacement ? [
      { name: 'text_position', type: 'select', label: 'Text position', options: [...TEXT_PLACES], option_labels: PLACE_LABELS, default: 'top-center', responsive: true,
        responsive_css: Object.fromEntries(TEXT_PLACES.map(place => [place, placeCss(place)])), ...v14,
        help: 'Where the text sits over the background, for each screen size. Give the section a height so there is room to move it.' } as FieldDefinition,
      { name: 'min_height', type: 'select', label: 'Minimum height', options: ['auto', 'sm', 'md', 'lg', 'screen'], option_labels: ['Content', 'Small', 'Medium', 'Large', 'Full screen'], default: 'auto', ...v14 } as FieldDefinition,
    ] : []),
  ];
  return fields;
}

/** Block types with text over media, and whether the text can be placed. */
const TEXT_OVER_MEDIA_TYPES: Readonly<Record<string, boolean>> = { 'core/section': true, 'core/hero': false, 'core/cta': false };

/** Block types that take the entrance animation field. */
export const MOTION_BLOCK_TYPES: ReadonlySet<string> = new Set([
  'core/section', 'core/container', 'core/grid', 'core/columns', 'core/repeater',
  'core/gallery', 'core/logo_cloud', 'core/feature_grid', 'core/testimonials', 'core/team_grid', 'core/pricing_table',
  'core/hero', 'core/cta', 'core/feature_row', 'core/media_card', 'core/image', 'core/heading', 'core/video',
  'core/stats', 'core/timeline', 'core/before_after', 'core/audio',
]);

/** The element that moves when it is not the block itself. */
const MOTION_TARGETS: Readonly<Record<string, string>> = {
  'core/hero': '.block-hero-inner',
  'core/cta': '.block-cta-inner',
};

/** Block types with media behind them, and whether the field set adds the image. */
const BACKGROUND_MEDIA_TYPES: Readonly<Record<string, boolean>> = { 'core/section': true, 'core/container': false, 'core/cta': false };

/** Registry pass: the effect fields for the types that offer them. */
export function withPresentationEffectFields(block: BlockType): BlockType {
  const extra: FieldDefinition[] = [];
  const has = (name: string) => block.schema.some(field => field.name === name);
  if (block.id in BACKGROUND_MEDIA_TYPES) {
    for (const field of backgroundMediaFields(BACKGROUND_MEDIA_TYPES[block.id]!)) if (!has(field.name)) extra.push(field);
  }
  if (block.id in TEXT_OVER_MEDIA_TYPES) {
    for (const field of textOverMediaFields(TEXT_OVER_MEDIA_TYPES[block.id]!)) if (!has(field.name)) extra.push(field);
  }
  if (MOTION_BLOCK_TYPES.has(block.id) && !has('motion')) extra.push(motionField);
  return extra.length ? { ...block, schema: [...block.schema, ...extra] } : block;
}

export interface EffectContext {
  renderVersion: number;
  /** The site's `motion` setting. */
  siteMotion?: unknown;
  language?: unknown;
}

const MOTION_VALUES = new Set<string>(MOTION_OPTIONS.filter(value => value !== 'none'));

/** Root attributes for a block's entrance animation, or none. */
export function motionAttributes(blockType: BlockType, data: Record<string, unknown>, context: EffectContext): Record<string, string> {
  if (context.renderVersion < 14 || context.siteMotion === 'reduced' || !blockType.schema.some(field => field.name === 'motion')) return {};
  const motion = String(data.motion ?? '');
  if (!MOTION_VALUES.has(motion)) return {};
  const attrs: Record<string, string> = { 'data-motion': motion };
  if (blockType.container) attrs['data-motion-children'] = '';
  const target = MOTION_TARGETS[blockType.id];
  if (target) attrs['data-motion-target'] = target;
  return attrs;
}

/**
 * Media behind a section, container or call to action: root attributes and
 * the markup that goes first inside the root element.
 */
export function backgroundMedia(blockType: BlockType, data: Record<string, unknown>, context: EffectContext): { attrs: Record<string, string>; html: string } {
  const none = { attrs: {}, html: '' };
  if (context.renderVersion < 14 || !(blockType.id in BACKGROUND_MEDIA_TYPES)) return none;
  const ownImage = BACKGROUND_MEDIA_TYPES[blockType.id] ? mediaAddress(data.background_image) : '';
  // Container and CTA paint their own background image; it is the video's poster.
  const paintedImage = blockType.id === 'core/container' || (blockType.id === 'core/cta' && data.image_position === 'background') ? mediaAddress(data.background_image) : '';
  const reduced = context.siteMotion === 'reduced';
  const video = reduced ? '' : videoFileAddress(data.background_video);
  if (!ownImage && !video) return none;
  const overlayRaw = Number(data.background_overlay ?? 40);
  const overlay = Number.isFinite(overlayRaw) ? Math.min(100, Math.max(0, overlayRaw)) : 40;
  const poster = ownImage || paintedImage;
  const phones = data.background_video_phones === 'play' ? 'play' : 'poster';
  const attrs: Record<string, string> = { 'data-bg-media': video ? 'video' : 'image' };
  if (String(data.text_color ?? '').trim() || overlay === 0) attrs['data-bg-own-fg'] = '';
  const layers = [
    ownImage ? `<img src="${escapeAttr(ownImage)}" alt="" loading="lazy" decoding="async" />` : '',
    video ? `<video data-src="${escapeAttr(video)}"${poster ? ` poster="${escapeAttr(poster)}"` : ''} data-phones="${phones}" muted loop playsinline preload="none"></video>` : '',
  ].join('');
  const toggle = video
    ? `<button type="button" class="tr-bg-media-toggle" data-label-pause="${escapeAttr(uiLabel(context.language, 'pause_animation'))}" data-label-play="${escapeAttr(uiLabel(context.language, 'play_animation'))}" aria-label="${escapeAttr(uiLabel(context.language, 'pause_animation'))}" hidden>${PAUSE_ICON}</button>`
    : '';
  const focal = (axis: 'x' | 'y') => {
    const value = Number(data[`background_focal_${axis}`]);
    return Number.isFinite(value) && value >= 0 && value <= 100 && value !== 50 ? `;--focal_${axis}:${value}` : '';
  };
  return { attrs, html: `<div class="tr-bg-media" aria-hidden="true" style="--bg-overlay:${overlay / 100}${focal('x')}${focal('y')}">${layers}</div>${toggle}` };
}

/**
 * Root attributes and inline custom properties for text over media. Absent
 * fields render nothing, so a block that uses none of them is unchanged.
 */
export function textOverMedia(blockType: BlockType, data: Record<string, unknown>, context: EffectContext, authored: Record<string, unknown> = {}): { attrs: Record<string, string>; style: string } {
  const none = { attrs: {}, style: '' };
  if (context.renderVersion < 14 || !(blockType.id in TEXT_OVER_MEDIA_TYPES)) return none;
  const attrs: Record<string, string> = {};
  const style: string[] = [];
  const overlay = String(data.overlay_style ?? 'solid');
  if (overlay === 'gradient' || overlay === 'spot') {
    attrs['data-overlay'] = overlay;
    if (overlay === 'gradient') attrs['data-overlay-side'] = ['top', 'start', 'end'].includes(String(data.overlay_side)) ? String(data.overlay_side) : 'bottom';
  }
  const color = String(data.overlay_color ?? '').trim();
  if (color && /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%/]+\)|hsla?\([\d\s.,%/deg]+\)|[a-z]+)$/i.test(color)) style.push(`--bg-overlay-color:${color}`);
  const panel = String(data.text_panel ?? 'none');
  if ((TEXT_PANELS as readonly string[]).includes(panel) && panel !== 'none') {
    attrs['data-panel'] = panel;
    const shape = String(data.text_panel_shape ?? 'rounded');
    attrs['data-panel-shape'] = (TEXT_PANEL_SHAPES as readonly string[]).includes(shape) ? shape : 'rounded';
  }
  if (TEXT_OVER_MEDIA_TYPES[blockType.id]) {
    const place = String(data.text_position ?? 'top-center');
    const varies = authored.text_position !== null && typeof authored.text_position === 'object';
    if ((TEXT_PLACES as readonly string[]).includes(place) && (place !== 'top-center' || varies)) {
      attrs['data-text-place'] = '';
      style.push(placeCss(place).replace(/;$/, ''));
    }
    const height = String(data.min_height ?? 'auto');
    if (['sm', 'md', 'lg', 'screen'].includes(height)) attrs['data-min-h'] = height;
  }
  if (blockType.id === 'core/hero' && attrs['data-overlay'] === 'spot') {
    // The hero places its text with its own fields; the spot follows them.
    const x = { start: '25%', center: '50%', end: '75%' }[String(data.text_align ?? 'start')] ?? '25%';
    const y = { start: '25%', center: '50%', end: '75%' }[String(data.text_vertical ?? 'center')] ?? '50%';
    style.push(`--spot-x:${x};--spot-y:${y}`);
  }
  return { attrs, style: style.join(';') };
}

/** Insert markup right after the opening tag of the first element. */
export function insertAfterFirstTag(html: string, inner: string): string {
  if (!inner) return html;
  return html.replace(/^(\s*<[a-zA-Z][\w-]*(?:[^>"']|"[^"]*"|'[^']*')*?>)/, (open) => `${open}${inner}`);
}

/** Root attributes for a gallery that opens its images larger. */
export function lightboxAttributes(language: unknown): Record<string, string> {
  return {
    'data-lightbox': '',
    'data-label-enlarge': uiLabel(language, 'enlarge_image'),
    'data-label-close': uiLabel(language, 'close'),
    'data-label-previous': uiLabel(language, 'previous'),
    'data-label-next': uiLabel(language, 'next'),
  };
}

/** Which shared effects a block tree uses, so only their CSS and runtimes ship. */
export function usedEffects(blocks: readonly Block[]): { motion: boolean; backgroundVideo: boolean; backgroundMedia: boolean; lightbox: boolean; marquee: boolean; textOverMedia: boolean } {
  const used = { motion: false, backgroundVideo: false, backgroundMedia: false, lightbox: false, marquee: false, textOverMedia: false };
  const visit = (list: readonly Block[] | undefined) => {
    for (const block of list ?? []) {
      const data = block.data ?? {};
      if (MOTION_BLOCK_TYPES.has(block.type) && MOTION_VALUES.has(String(data.motion ?? ''))) used.motion = true;
      if (block.type in BACKGROUND_MEDIA_TYPES) {
        if (videoFileAddress(data.background_video)) { used.backgroundVideo = true; used.backgroundMedia = true; }
        if (BACKGROUND_MEDIA_TYPES[block.type] && mediaAddress(data.background_image)) used.backgroundMedia = true;
      }
      if (block.type in TEXT_OVER_MEDIA_TYPES && (['gradient', 'spot'].includes(String(data.overlay_style)) || (data.text_panel && data.text_panel !== 'none') || data.overlay_color || (TEXT_OVER_MEDIA_TYPES[block.type] && ((data.text_position && data.text_position !== 'top-center') || (data.min_height && data.min_height !== 'auto'))))) used.textOverMedia = true;
      if (block.type === 'core/gallery' && data.lightbox !== false) used.lightbox = true;
      if (block.type === 'core/logo_cloud' && data.layout === 'marquee') used.marquee = true;
      visit(block.children);
      for (const slot of block.slots ?? []) visit(slot);
    }
  };
  visit(blocks);
  return used;
}

export const MOTION_CSS = `
:where(:root) { --motion-duration:.6s; --motion-easing:cubic-bezier(.2,.65,.25,1); --motion-distance:1.5rem; --motion-scale:.94; --motion-stagger:90ms; }
/* Only the runtime hides an element, and only until it enters. Print and no-script show everything. */
@media screen {
  html[data-tr-motion] [data-motion-item]:not([data-motion-item="custom"]):not([data-motion-in]) { opacity:0; }
  html[data-tr-motion] [data-motion-item="rise"]:not([data-motion-in]) { translate:0 var(--motion-distance); }
  html[data-tr-motion] [data-motion-item="scale"]:not([data-motion-in]) { scale:var(--motion-scale); }
  html[data-tr-motion] [data-motion-in="run"]:not([data-motion-item="custom"]) {
    transition:opacity var(--motion-duration) var(--motion-easing), translate var(--motion-duration) var(--motion-easing), scale var(--motion-duration) var(--motion-easing);
    transition-delay:calc(var(--motion-index, 0) * var(--motion-stagger));
  }
  ${Array.from({ length: 8 }, (_, i) => `[data-motion-index="${i + 1}"] { --motion-index:${i + 1}; }`).join(' ')}
}`.trim();

export const BACKGROUND_MEDIA_CSS = `
[data-bg-media] { position:relative; isolation:isolate; }
/* White text over the darkened media, unless the block sets its own text color. */
[data-bg-media]:not([data-bg-own-fg]) { color:#fff; --color-text:#fff; --color-text-light:rgb(255 255 255 / .82); }
[data-bg-media] > .tr-bg-media { position:absolute; inset:0; z-index:-1; overflow:hidden; pointer-events:none; border-radius:inherit; margin:0; max-inline-size:none; }
.tr-bg-media > :is(img, video) { position:absolute; inset:0; inline-size:100%; block-size:100%; max-inline-size:none; object-fit:cover; object-position:calc(var(--focal_x, 50) * 1%) calc(var(--focal_y, 50) * 1%); }
.tr-bg-media > video { opacity:0; transition:opacity .4s ease; }
.tr-bg-media > video[data-playing] { opacity:1; }
.tr-bg-media::after { content:""; position:absolute; inset:0; background:var(--bg-overlay-color, #000); opacity:var(--bg-overlay, .4); }
.tr-bg-media-toggle { position:absolute; inset-block-end:.75rem; inset-inline-end:.75rem; z-index:1; display:inline-grid; place-items:center; inline-size:2.5rem; block-size:2.5rem; padding:0; border:0; border-radius:999px; background:rgb(0 0 0 / .55); color:#fff; cursor:pointer; }
.tr-bg-media-toggle[hidden] { display:none; }
.tr-bg-media-toggle:focus-visible { outline:2px solid #fff; outline-offset:2px; }
@media (prefers-reduced-motion: reduce) { .tr-bg-media > video, .tr-bg-media-toggle { display:none; } }
/* An eyebrow in the accent color does not read on darkened media; it takes the text color there. */
[data-bg-media]:not([data-bg-own-fg], [data-panel="solid"], [data-panel="light_translucent"], [data-panel="light_glass"]) .tr-role-eyebrow:not(#\\#) { color:var(--on-media-accent, inherit); }`.trim();

const PANEL_TARGETS = (root: string) => `${root}[data-block="hero"] .block-hero-text, ${root}[data-block="cta"] .block-cta-inner, ${root}[data-block="section"] > .block-section-inner`;

export const TEXT_OVER_MEDIA_CSS = `
/* Darkening from one side, or a soft spot behind the text. */
[data-overlay="gradient"] { --tr-overlay-angle:0deg; --tr-overlay-image:linear-gradient(var(--tr-overlay-angle), var(--bg-overlay-color, #000) 0%, color-mix(in srgb, var(--bg-overlay-color, #000) 55%, transparent) 40%, transparent 75%); }
[data-overlay-side="top"] { --tr-overlay-angle:180deg; }
[data-overlay-side="start"] { --tr-overlay-angle:90deg; }
[data-overlay-side="end"] { --tr-overlay-angle:270deg; }
:dir(rtl)[data-overlay-side="start"] { --tr-overlay-angle:270deg; }
:dir(rtl)[data-overlay-side="end"] { --tr-overlay-angle:90deg; }
/* On phones text runs the full width, so darkening from a side darkens from the bottom instead. */
@media (max-width: 767px) { [data-overlay-side]:is([data-overlay-side="start"], [data-overlay-side="end"]) { --tr-overlay-angle:0deg; } }
[data-overlay="spot"] { --tr-overlay-image:radial-gradient(ellipse 70% 65% at var(--spot-x, 50%) var(--spot-y, 50%), var(--bg-overlay-color, #000) 0%, color-mix(in srgb, var(--bg-overlay-color, #000) 50%, transparent) 45%, transparent 80%); }
[data-overlay] > .tr-bg-media::after { background:var(--tr-overlay-image); }
[data-block="hero"][data-overlay] > .block-hero-overlay { background:var(--tr-overlay-image); }
[data-block="hero"]:not([data-overlay]) > .block-hero-overlay { background:var(--bg-overlay-color, rgba(0,0,0,0.5)); }
/* A section that places its text: room to move it, and the text box at the chosen place. */
[data-block="section"][data-min-h="sm"] { min-block-size:24rem; }
[data-block="section"][data-min-h="md"] { min-block-size:36rem; }
[data-block="section"][data-min-h="lg"] { min-block-size:48rem; }
[data-block="section"][data-min-h="screen"] { min-block-size:calc(100svh - var(--tr-header-height, 0px)); }
[data-block="section"]:is([data-text-place], [data-min-h]) { display:flex; flex-direction:column; justify-content:var(--text-y, flex-start); }
/* The text lines up with the content column of the sections around it. */
[data-block="section"][data-text-place] { --tr-band:var(--content-normal, 65rem); --tr-edge:max(0px, (100% - var(--max_width_px, var(--tr-band))) / 2); }
[data-block="section"][data-text-place][data-width="narrow"] { --tr-band:var(--content-narrow, 42rem); }
[data-block="section"][data-text-place][data-width="wide"] { --tr-band:var(--content-wide, 80rem); }
[data-block="section"][data-text-place][data-width="full"] { --tr-band:100%; }
[data-block="section"][data-text-place] > .block-section-inner { box-sizing:border-box; inline-size:100%; max-inline-size:min(100%, var(--panel-width, 40rem)); margin-inline:var(--text-margins, auto); text-align:var(--text-align, start); }
/* Plates behind the text. */
:is(${PANEL_TARGETS('[data-panel]')}) { box-sizing:border-box; padding:var(--panel-padding, clamp(1.25rem, 4vw, 2.5rem)); border-radius:var(--panel-radius, 1rem); clip-path:var(--panel-clip, none); }
/* A plate holds a readable measure of text, except a full-width band. */
:is(${PANEL_TARGETS('[data-panel]:not([data-panel="band"])')}) { max-inline-size:min(100%, var(--panel-width, 40rem)); }
:is(${PANEL_TARGETS('[data-panel="solid"]')}) { background:var(--panel-bg, var(--color-background, #fff)); color:var(--panel-fg, var(--color-text, #111)); --color-text:var(--panel-fg, #111); --color-text-light:color-mix(in srgb, var(--panel-fg, #111) 72%, transparent); }
:is(${PANEL_TARGETS('[data-panel="dark_translucent"]')}) { background:var(--panel-bg, rgb(0 0 0 / .58)); color:#fff; --color-text:#fff; }
:is(${PANEL_TARGETS('[data-panel="light_translucent"]')}) { background:var(--panel-bg, rgb(255 255 255 / .82)); color:#111; --color-text:#111; --color-text-light:#3f3f46; }
:is(${PANEL_TARGETS('[data-panel="dark_glass"]')}) { background:var(--panel-bg, rgb(12 12 16 / .38)); -webkit-backdrop-filter:blur(var(--panel-blur, 16px)) saturate(140%); backdrop-filter:blur(var(--panel-blur, 16px)) saturate(140%); box-shadow:inset 0 0 0 1px rgb(255 255 255 / .18); color:#fff; --color-text:#fff; }
:is(${PANEL_TARGETS('[data-panel="light_glass"]')}) { background:var(--panel-bg, rgb(255 255 255 / .55)); -webkit-backdrop-filter:blur(var(--panel-blur, 16px)) saturate(160%); backdrop-filter:blur(var(--panel-blur, 16px)) saturate(160%); box-shadow:inset 0 0 0 1px rgb(255 255 255 / .5); color:#111; --color-text:#111; --color-text-light:#3f3f46; }
:is(${PANEL_TARGETS('[data-panel="band"]')}) { max-inline-size:none; inline-size:100%; border-radius:0; background:var(--panel-bg, rgb(0 0 0 / .5)); -webkit-backdrop-filter:blur(var(--panel-blur, 10px)); backdrop-filter:blur(var(--panel-blur, 10px)); color:#fff; --color-text:#fff; }
:is(${PANEL_TARGETS('[data-panel="dark_translucent"]')}, ${PANEL_TARGETS('[data-panel="dark_glass"]')}, ${PANEL_TARGETS('[data-panel="band"]')}) .tr-role-eyebrow:not(#\\#) { color:var(--on-media-accent, inherit); }
:is(${PANEL_TARGETS('[data-panel-shape="square"]')}) { --panel-radius:0; }
:is(${PANEL_TARGETS('[data-panel-shape="pill"]')}) { --panel-radius:2.5rem; padding-inline:var(--panel-padding-inline, clamp(1.5rem, 5vw, 3rem)); }
:is(${PANEL_TARGETS('[data-panel-shape="blob"]')}) { --panel-radius:46% 54% 52% 48% / 40% 44% 56% 60%; padding:var(--panel-padding, clamp(2rem, 7vw, 4rem)); }
:is(${PANEL_TARGETS('[data-panel-shape="slant"]')}) { --panel-radius:0; --panel-clip:polygon(0 0, 100% 0, calc(100% - 2.5rem) 100%, 0 100%); padding-inline-end:calc(var(--panel-padding, clamp(1.25rem, 4vw, 2.5rem)) + 2.5rem); }
:dir(rtl):is(${PANEL_TARGETS('[data-panel-shape="slant"]')}) { --panel-clip:polygon(0 0, 100% 0, 100% 100%, 2.5rem 100%); }
/* Glass needs something behind it to blur; browsers without blur get a stronger see-through plate. */
@supports not ((backdrop-filter:blur(1px)) or (-webkit-backdrop-filter:blur(1px))) {
  :is(${PANEL_TARGETS('[data-panel="dark_glass"]')}) { background:var(--panel-bg, rgb(12 12 16 / .62)); }
  :is(${PANEL_TARGETS('[data-panel="light_glass"]')}) { background:var(--panel-bg, rgb(255 255 255 / .85)); }
}`.trim();

export const LIGHTBOX_CSS = `
[data-lightbox] img[data-lightbox-index] { cursor:zoom-in; }
[data-lightbox] img[data-lightbox-index]:focus-visible { outline:3px solid var(--color-primary, #111); outline-offset:3px; }
.tr-lightbox { box-sizing:border-box; inline-size:100vw; block-size:100dvh; max-inline-size:none; max-block-size:none; margin:0; padding:0; border:0; background:rgb(10 10 12 / .94); color:#fff; overscroll-behavior:contain; }
.tr-lightbox::backdrop { background:rgb(0 0 0 / .6); }
.tr-lightbox-figure { box-sizing:border-box; display:grid; grid-template-rows:minmax(0,1fr) auto; place-items:center; gap:.75rem; block-size:100%; margin:0; padding:3.75rem clamp(.75rem, 6vw, 4.5rem) 1.25rem; }
.tr-lightbox-figure img { display:block; max-inline-size:100%; max-block-size:100%; inline-size:auto; block-size:auto; object-fit:contain; touch-action:pan-y pinch-zoom; }
.tr-lightbox-figure figcaption { max-inline-size:48rem; text-align:center; font-size:.9375rem; line-height:1.5; opacity:.9; }
.tr-lightbox-figure figcaption:empty { display:none; }
.tr-lightbox-count { position:absolute; inset-block-start:1rem; inset-inline-start:1rem; margin:0; font-size:.875rem; opacity:.8; }
.tr-lightbox-button { position:absolute; display:inline-grid; place-items:center; inline-size:2.75rem; block-size:2.75rem; padding:0; border:0; border-radius:999px; background:rgb(255 255 255 / .14); color:#fff; cursor:pointer; }
.tr-lightbox-button:hover { background:rgb(255 255 255 / .24); }
.tr-lightbox-button:focus-visible { outline:2px solid #fff; outline-offset:2px; }
.tr-lightbox-button[hidden] { display:none; }
.tr-lightbox-close { inset-block-start:.625rem; inset-inline-end:.625rem; }
.tr-lightbox-prev, .tr-lightbox-next { inset-block-start:50%; translate:0 -50%; }
.tr-lightbox-prev { inset-inline-start:.625rem; }
.tr-lightbox-next { inset-inline-end:.625rem; }
@media (max-width: 640px) { .tr-lightbox-prev, .tr-lightbox-next { inset-block-start:auto; inset-block-end:.75rem; translate:none; } }`.trim();

export const MARQUEE_CSS = `
[data-block="repeater"][data-layout="marquee"] { --marquee-gap:clamp(2rem, 5vw, 4rem); position:relative; overflow:hidden; }
[data-layout="marquee"] > .tr-marquee-track { display:flex; flex-wrap:wrap; justify-content:center; align-items:center; gap:1.5rem var(--marquee-gap); }
[data-layout="marquee"] > .tr-marquee-track > * { flex:0 0 auto; inline-size:var(--marquee-item, clamp(6rem, 18vw, 9rem)); }
[data-layout="marquee"][data-marquee-ready] { mask-image:linear-gradient(90deg, transparent, #000 8%, #000 92%, transparent); }
[data-layout="marquee"][data-marquee-ready] > .tr-marquee-track { flex-wrap:nowrap; justify-content:flex-start; inline-size:max-content; animation:tr-marquee var(--marquee-duration, 30s) linear infinite; }
[data-layout="marquee"][data-marquee-ready]:is(:hover, :focus-within, [data-paused]) > .tr-marquee-track { animation-play-state:paused; }
[dir="rtl"] [data-layout="marquee"][data-marquee-ready] > .tr-marquee-track, [data-layout="marquee"][data-marquee-ready]:dir(rtl) > .tr-marquee-track { animation-direction:reverse; }
.tr-marquee-toggle { display:flex; align-items:center; justify-content:center; inline-size:2.25rem; block-size:2.25rem; margin:.75rem auto 0; padding:0; border:0; border-radius:999px; background:var(--color-surface, #f4f4f5); color:var(--color-text, #111); cursor:pointer; }
.tr-marquee-toggle[hidden] { display:none; }
.tr-marquee-toggle:focus-visible { outline:2px solid currentColor; outline-offset:2px; }
@keyframes tr-marquee { to { translate:calc(-50% - var(--marquee-gap) / 2) 0; } }
@media (prefers-reduced-motion: reduce) { [data-layout="marquee"] > .tr-marquee-track { animation:none !important; } }`.trim();

export const MOTION_RUNTIME = String.raw`
(function () {
  var root = document.documentElement;
  if (!('IntersectionObserver' in window) || (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches)) return;
  var items = [];
  document.querySelectorAll('[data-motion]').forEach(function (el) {
    var kind = el.getAttribute('data-motion');
    var targets = [];
    if (el.hasAttribute('data-motion-children')) {
      el.querySelectorAll('[data-block]').forEach(function (child) {
        if (child.parentElement && child.parentElement.closest('[data-block]') === el && !child.hasAttribute('data-motion')) targets.push(child);
      });
    } else {
      var selector = el.getAttribute('data-motion-target');
      var target = selector ? el.querySelector(selector) : null;
      targets.push(target || el);
    }
    if (!targets.length) targets.push(el);
    targets.forEach(function (t) { if (!t.hasAttribute('data-motion-item')) { t.setAttribute('data-motion-item', kind); items.push(t); } });
  });
  if (!items.length) return;
  function done(t) { t.setAttribute('data-motion-in', 'done'); }
  var observer = new IntersectionObserver(function (entries) {
    var n = 0;
    entries.forEach(function (entry) {
      if (!entry.isIntersecting) return;
      var t = entry.target;
      observer.unobserve(t);
      // An attribute, not an inline style: a block's own CSS may read its style attribute.
      t.setAttribute('data-motion-index', String(Math.min(n++, 8)));
      t.setAttribute('data-motion-in', 'run');
      t.dispatchEvent(new CustomEvent('typeroll:motion-in', { bubbles: true }));
      var end = function () { t.removeEventListener('transitionend', end); done(t); };
      t.addEventListener('transitionend', end);
      setTimeout(end, 2500);
    });
  }, { rootMargin: '0px 0px -8% 0px' });
  var height = window.innerHeight || root.clientHeight;
  // What is on screen at load stays as it is; the rest enters as it scrolls in.
  items.forEach(function (t) { var r = t.getBoundingClientRect(); if (r.top < height && r.bottom > 0) done(t); else observer.observe(t); });
  root.setAttribute('data-tr-motion', '');
})();
`.trim();

export const BACKGROUND_MEDIA_RUNTIME = String.raw`
(function () {
  if (!('IntersectionObserver' in window) || (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches)) return;
  var phone = window.matchMedia && matchMedia('(max-width: 767px)');
  var PAUSE = ${JSON.stringify(PAUSE_ICON)}, PLAY = ${JSON.stringify(PLAY_ICON)};
  document.querySelectorAll('[data-bg-media] > .tr-bg-media > video[data-src]').forEach(function (video) {
    var host = video.parentElement.parentElement;
    if (video.getAttribute('data-phones') !== 'play' && phone && phone.matches) return;
    var toggle = host.querySelector(':scope > .tr-bg-media-toggle');
    var paused = false;
    function play() {
      if (!video.getAttribute('src')) video.setAttribute('src', video.getAttribute('data-src'));
      var played = video.play(); if (played && played.catch) played.catch(function () {});
    }
    video.addEventListener('playing', function () { video.setAttribute('data-playing', ''); });
    new IntersectionObserver(function (entries) {
      if (entries[0].isIntersecting && !paused) play(); else video.pause();
    }, { rootMargin: '200px 0px' }).observe(host);
    if (!toggle) return;
    toggle.hidden = false;
    toggle.addEventListener('click', function () {
      paused = !paused;
      if (paused) video.pause(); else play();
      toggle.setAttribute('aria-label', paused ? toggle.dataset.labelPlay : toggle.dataset.labelPause);
      toggle.innerHTML = paused ? PLAY : PAUSE;
    });
  });
})();
`.trim();

const CLOSE_ICON = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true" focusable="false"><path d="M6 6l12 12M18 6 6 18"/></svg>';
const LEFT_ICON = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="m15 18-6-6 6-6"/></svg>';
const RIGHT_ICON = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="m9 18 6-6-6-6"/></svg>';

export const LIGHTBOX_RUNTIME = String.raw`
(function () {
  if (typeof HTMLDialogElement !== 'function') return;
  var dialog, image, caption, count, prev, next, list = [], index = 0;
  function largest(img) {
    var best = img.currentSrc || img.src, width = 0;
    (img.getAttribute('srcset') || '').split(',').forEach(function (part) {
      var bits = part.trim().split(/\s+/), w = parseInt(bits[1], 10);
      if (bits[0] && w > width) { width = w; best = bits[0]; }
    });
    return best;
  }
  function textOf(img) {
    var figure = img.closest('figure'), cap = figure && figure.querySelector('figcaption');
    return (cap && cap.textContent.trim()) || '';
  }
  function show(i) {
    index = (i + list.length) % list.length;
    var img = list[index];
    image.src = largest(img);
    image.alt = img.alt || '';
    caption.textContent = textOf(img);
    count.textContent = (index + 1) + ' / ' + list.length;
    prev.hidden = next.hidden = list.length < 2;
  }
  function build(labels) {
    dialog = document.createElement('dialog');
    dialog.className = 'tr-lightbox';
    dialog.innerHTML = '<figure class="tr-lightbox-figure"><img alt=""><figcaption></figcaption></figure><p class="tr-lightbox-count" aria-live="polite"></p>'
      + '<button type="button" class="tr-lightbox-button tr-lightbox-close">${CLOSE_ICON}</button>'
      + '<button type="button" class="tr-lightbox-button tr-lightbox-prev">${LEFT_ICON}</button>'
      + '<button type="button" class="tr-lightbox-button tr-lightbox-next">${RIGHT_ICON}</button>';
    document.body.appendChild(dialog);
    image = dialog.querySelector('img'); caption = dialog.querySelector('figcaption'); count = dialog.querySelector('.tr-lightbox-count');
    prev = dialog.querySelector('.tr-lightbox-prev'); next = dialog.querySelector('.tr-lightbox-next');
    prev.addEventListener('click', function () { show(index - 1); });
    next.addEventListener('click', function () { show(index + 1); });
    dialog.querySelector('.tr-lightbox-close').addEventListener('click', function () { dialog.close(); });
    dialog.addEventListener('click', function (event) { if (event.target === dialog || event.target.classList.contains('tr-lightbox-figure')) dialog.close(); });
    dialog.addEventListener('keydown', function (event) {
      var rtl = getComputedStyle(dialog).direction === 'rtl';
      if (event.key === 'ArrowLeft') show(index + (rtl ? 1 : -1));
      if (event.key === 'ArrowRight') show(index + (rtl ? -1 : 1));
    });
    var startX = null;
    image.addEventListener('pointerdown', function (event) { startX = event.clientX; });
    image.addEventListener('pointerup', function (event) {
      if (startX === null) return;
      var dx = event.clientX - startX; startX = null;
      if (Math.abs(dx) > 50) show(index + (dx < 0 ? 1 : -1));
    });
  }
  function label(labels) {
    dialog.querySelector('.tr-lightbox-close').setAttribute('aria-label', labels.labelClose);
    prev.setAttribute('aria-label', labels.labelPrevious);
    next.setAttribute('aria-label', labels.labelNext);
  }
  document.querySelectorAll('[data-lightbox]').forEach(function (gallery) {
    var images = [].filter.call(gallery.querySelectorAll('img'), function (img) { return img.getAttribute('src') && !img.closest('a[href]'); });
    images.forEach(function (img, i) {
      img.setAttribute('data-lightbox-index', String(i));
      img.setAttribute('tabindex', '0');
      img.setAttribute('role', 'button');
      img.setAttribute('aria-label', gallery.dataset.labelEnlarge + (img.alt ? ': ' + img.alt : ''));
      function open() {
        if (!dialog) build();
        label(gallery.dataset);
        list = images;
        show(i);
        dialog.showModal();
      }
      img.addEventListener('click', open);
      img.addEventListener('keydown', function (event) { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); } });
    });
  });
})();
`.trim();

export const MARQUEE_RUNTIME = String.raw`
(function () {
  if (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  var PAUSE = ${JSON.stringify(PAUSE_ICON)}, PLAY = ${JSON.stringify(PLAY_ICON)};
  document.querySelectorAll('[data-layout="marquee"]:not([data-static])').forEach(function (el) {
    var track = el.querySelector(':scope > .tr-marquee-track');
    if (!track || !track.children.length) return;
    var originals = [].slice.call(track.children);
    // A second copy makes the loop seamless; it is hidden from assistive technology and the keyboard.
    originals.forEach(function (item) {
      var copy = item.cloneNode(true);
      copy.setAttribute('aria-hidden', 'true');
      copy.setAttribute('inert', '');
      copy.querySelectorAll('[id]').forEach(function (node) { node.removeAttribute('id'); });
      copy.removeAttribute('id');
      track.appendChild(copy);
    });
    track.style.setProperty('--marquee-duration', Math.max(16, originals.length * 4) + 's');
    el.setAttribute('data-marquee-ready', '');
    var toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'tr-marquee-toggle';
    var paused = false;
    function render() { toggle.setAttribute('aria-label', paused ? el.dataset.labelPlay : el.dataset.labelPause); toggle.innerHTML = paused ? PLAY : PAUSE; }
    toggle.addEventListener('click', function () { paused = !paused; if (paused) el.setAttribute('data-paused', ''); else el.removeAttribute('data-paused'); render(); });
    render();
    el.appendChild(toggle);
  });
})();
`.trim();

/** The shared effect CSS and runtimes a block tree needs at render version 14. */
export function effectAssets(blocks: readonly Block[], renderVersion: number): { css: string[]; js: string[] } {
  if (renderVersion < 14) return { css: [], js: [] };
  const used = usedEffects(blocks);
  const css: string[] = [];
  const js: string[] = [];
  if (used.motion) { css.push(`/* motion */\n${MOTION_CSS}`); js.push(`/* motion */\n${MOTION_RUNTIME}`); }
  if (used.backgroundMedia) css.push(`/* background media */\n${BACKGROUND_MEDIA_CSS}`);
  if (used.backgroundVideo) js.push(`/* background video */\n${BACKGROUND_MEDIA_RUNTIME}`);
  if (used.textOverMedia) css.push(`/* text over media */\n${TEXT_OVER_MEDIA_CSS}`);
  if (used.lightbox) { css.push(`/* lightbox */\n${LIGHTBOX_CSS}`); js.push(`/* lightbox */\n${LIGHTBOX_RUNTIME}`); }
  if (used.marquee) { css.push(`/* marquee */\n${MARQUEE_CSS}`); js.push(`/* marquee */\n${MARQUEE_RUNTIME}`); }
  return { css, js };
}
