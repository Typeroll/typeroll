// Core block library — ships with the platform. Six general-purpose blocks
// that cover the vast majority of page composition needs. Custom blocks
// (origin: 'user' or 'third_party') are loaded from the per-site
// block_types collection and merged on top of this list at render time.
//
// Each entry is a complete BlockType: schema (what the editor collects),
// template (HTML with {{field}} placeholders), styles (CSS scoped to the
// block via a `data-block` attribute), and metadata. Templates use
// semantic HTML; the block library does NOT prescribe a design system —
// the colors and fonts come from SiteSettings, applied via CSS variables
// in BaseLayout.

import { REPEATER_BLOCK_TYPES } from './repeater-blocks.js';
import { FORM_BLOCK_TYPES } from './form-blocks.js';
import { TEMPLATE_BLOCK_TYPES } from './template-blocks.js';
import { TIER1_BLOCK_TYPES } from './tier1-blocks.js';
import type { BlockType } from './types.js';

const ISO_EPOCH = '1970-01-01T00:00:00Z';

/**
 * `section` — outer container. Holds children, optional width constraint,
 * background color/image, and vertical padding. The first block dragged
 * onto an empty page is usually a section.
 */
const section: BlockType = {
  id: 'core/section',
  name: 'section',
  label: 'Section',
  icon: 'square',
  category: 'layout',
  container: true,
  schema: [
    {
      name: 'width',
      type: 'select',
      label: 'Width',
      options: ['narrow', 'normal', 'wide', 'full'],
      default: 'normal',
    },
    { name: 'padding_y', type: 'select', label: 'Vertical padding', options: ['none', 'sm', 'md', 'lg', 'xl'], default: 'md' },
    { name: 'background', type: 'color', label: 'Background color' },
    { name: 'text_color', type: 'color', label: 'Text color' },
    // Shaped section transitions. The divider is filled with THIS section's
    // own background colour and overlaps the neighbour by 1px — so it never
    // needs to know the adjacent colour and can never leave a hairline seam.
    // Use ONE divider per junction (typically the lower section's top).
    { name: 'divider_top', type: 'select', label: 'Top divider', options: ['none', 'wave', 'curve', 'tilt'], default: 'none' },
    { name: 'divider_bottom', type: 'select', label: 'Bottom divider', options: ['none', 'wave', 'curve', 'tilt'], default: 'none' },
  ],
  template: `<section data-block="section" data-width="{{width}}" data-pad="{{padding_y}}" data-divtop="{{divider_top}}" data-divbot="{{divider_bottom}}" style="--block-bg:{{background}};--block-fg:{{text_color}}">
  <span class="block-section-shape block-section-shape--top" aria-hidden="true"></span>
  <div class="block-section-inner">{{children}}</div>
  <span class="block-section-shape block-section-shape--bot" aria-hidden="true"></span>
</section>`,
  styles: `
[data-block="section"] { position: relative; padding: var(--block-pad-md, 4rem) 1rem; background: var(--block-bg, transparent); color: var(--block-fg, inherit); }
[data-block="section"][data-pad="none"] { padding-top: 0; padding-bottom: 0; }
[data-block="section"][data-pad="sm"] { padding-top: 2rem; padding-bottom: 2rem; }
[data-block="section"][data-pad="md"] { padding-top: 4rem; padding-bottom: 4rem; }
[data-block="section"][data-pad="lg"] { padding-top: 6rem; padding-bottom: 6rem; }
[data-block="section"][data-pad="xl"] { padding-top: 8rem; padding-bottom: 8rem; }
[data-block="section"] > .block-section-inner { max-width: 65rem; margin: 0 auto; }
[data-block="section"][data-width="narrow"] > .block-section-inner { max-width: 42rem; }
[data-block="section"][data-width="wide"] > .block-section-inner { max-width: 80rem; }
[data-block="section"][data-width="full"] > .block-section-inner { max-width: none; }
/* Section dividers — a full-bleed shape painted in the section's own
   --block-bg, overlapping the neighbour by 1px. Hidden unless a shape is set;
   invisible when the section has no background (nothing to paint). */
[data-block="section"] > .block-section-shape { display: none; position: absolute; left: 0; right: 0; height: clamp(34px, 6vw, 80px); background: var(--block-bg, transparent); pointer-events: none; z-index: 1; -webkit-mask-size: 100% 100%; mask-size: 100% 100%; -webkit-mask-repeat: no-repeat; mask-repeat: no-repeat; }
[data-block="section"][data-divtop="wave"] > .block-section-shape--top,
[data-block="section"][data-divtop="curve"] > .block-section-shape--top,
[data-block="section"][data-divtop="tilt"] > .block-section-shape--top { display: block; top: 0; transform: translateY(calc(-100% + 1px)); }
[data-block="section"][data-divbot="wave"] > .block-section-shape--bot,
[data-block="section"][data-divbot="curve"] > .block-section-shape--bot,
[data-block="section"][data-divbot="tilt"] > .block-section-shape--bot { display: block; bottom: 0; transform: translateY(calc(100% - 1px)); }
[data-block="section"][data-divtop="wave"] > .block-section-shape--top { -webkit-mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1440 100' preserveAspectRatio='none'%3E%3Cpath d='M0,46 C360,92 1080,4 1440,46 L1440,100 L0,100 Z' fill='%23000'/%3E%3C/svg%3E"); mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1440 100' preserveAspectRatio='none'%3E%3Cpath d='M0,46 C360,92 1080,4 1440,46 L1440,100 L0,100 Z' fill='%23000'/%3E%3C/svg%3E"); }
[data-block="section"][data-divtop="curve"] > .block-section-shape--top { -webkit-mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1440 100' preserveAspectRatio='none'%3E%3Cpath d='M0,64 C480,8 960,8 1440,64 L1440,100 L0,100 Z' fill='%23000'/%3E%3C/svg%3E"); mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1440 100' preserveAspectRatio='none'%3E%3Cpath d='M0,64 C480,8 960,8 1440,64 L1440,100 L0,100 Z' fill='%23000'/%3E%3C/svg%3E"); }
[data-block="section"][data-divtop="tilt"] > .block-section-shape--top { -webkit-mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1440 100' preserveAspectRatio='none'%3E%3Cpath d='M0,82 L1440,26 L1440,100 L0,100 Z' fill='%23000'/%3E%3C/svg%3E"); mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1440 100' preserveAspectRatio='none'%3E%3Cpath d='M0,82 L1440,26 L1440,100 L0,100 Z' fill='%23000'/%3E%3C/svg%3E"); }
[data-block="section"][data-divbot="wave"] > .block-section-shape--bot { -webkit-mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1440 100' preserveAspectRatio='none'%3E%3Cpath d='M0,0 L1440,0 L1440,54 C1080,96 360,8 0,54 Z' fill='%23000'/%3E%3C/svg%3E"); mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1440 100' preserveAspectRatio='none'%3E%3Cpath d='M0,0 L1440,0 L1440,54 C1080,96 360,8 0,54 Z' fill='%23000'/%3E%3C/svg%3E"); }
[data-block="section"][data-divbot="curve"] > .block-section-shape--bot { -webkit-mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1440 100' preserveAspectRatio='none'%3E%3Cpath d='M0,0 L1440,0 L1440,36 C960,92 480,92 0,36 Z' fill='%23000'/%3E%3C/svg%3E"); mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1440 100' preserveAspectRatio='none'%3E%3Cpath d='M0,0 L1440,0 L1440,36 C960,92 480,92 0,36 Z' fill='%23000'/%3E%3C/svg%3E"); }
[data-block="section"][data-divbot="tilt"] > .block-section-shape--bot { -webkit-mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1440 100' preserveAspectRatio='none'%3E%3Cpath d='M0,0 L1440,0 L1440,74 L0,18 Z' fill='%23000'/%3E%3C/svg%3E"); mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1440 100' preserveAspectRatio='none'%3E%3Cpath d='M0,0 L1440,0 L1440,74 L0,18 Z' fill='%23000'/%3E%3C/svg%3E"); }
`.trim(),
  origin: 'core',
  created_at: ISO_EPOCH,
};

/**
 * `columns` — slot-based two-column layout. The editor sees two named
 * drop targets (Left / Right) and can drag any block into either side.
 */
const columns: BlockType = {
  id: 'core/columns',
  name: 'columns',
  label: 'Two columns',
  icon: 'columns',
  category: 'layout',
  container: 'slots',
  slot_count: 2,
  slot_labels: ['Left', 'Right'],
  schema: [
    {
      name: 'ratio',
      type: 'select',
      label: 'Ratio',
      options: ['1-1', '2-1', '1-2', '3-1', '1-3'],
      default: '1-1',
    },
    { name: 'gap', type: 'select', label: 'Gap', options: ['sm', 'md', 'lg'], default: 'md' },
    { name: 'align', type: 'select', label: 'Vertical alignment', options: ['start', 'center', 'end'], default: 'start' },
  ],
  template: `<div data-block="columns" data-ratio="{{ratio}}" data-gap="{{gap}}" data-align="{{align}}">
  <div class="block-columns-col">{{slot:Left}}</div>
  <div class="block-columns-col">{{slot:Right}}</div>
</div>`,
  styles: `
[data-block="columns"] { display: grid; grid-template-columns: 1fr 1fr; gap: 2rem; }
[data-block="columns"][data-ratio="2-1"] { grid-template-columns: 2fr 1fr; }
[data-block="columns"][data-ratio="1-2"] { grid-template-columns: 1fr 2fr; }
[data-block="columns"][data-ratio="3-1"] { grid-template-columns: 3fr 1fr; }
[data-block="columns"][data-ratio="1-3"] { grid-template-columns: 1fr 3fr; }
[data-block="columns"][data-gap="sm"] { gap: 1rem; }
[data-block="columns"][data-gap="lg"] { gap: 3rem; }
[data-block="columns"][data-align="center"] { align-items: center; }
[data-block="columns"][data-align="end"] { align-items: end; }
/* An optional server-rendered outline should not reserve an unexplained
   sidebar when the selected body has no headings. */
[data-block="columns"]:has(> .block-columns-col:last-child > [data-block="table_of_contents"][data-empty="true"]) {
  grid-template-columns: minmax(0, 1fr);
}
/* Mobile: collapse to a single column. The ratio rules above carry an extra
   attribute selector (specificity 0,2,0); a media query adds no specificity,
   so a bare [data-block="columns"] (0,1,0) here would LOSE to them and only
   the default 1-1 would ever stack. Enumerate the ratios so the collapse
   matches their specificity and wins by source order. */
@media (max-width: 720px) {
  [data-block="columns"],
  [data-block="columns"][data-ratio="2-1"],
  [data-block="columns"][data-ratio="1-2"],
  [data-block="columns"][data-ratio="3-1"],
  [data-block="columns"][data-ratio="1-3"] { grid-template-columns: 1fr; }
}
`.trim(),
  origin: 'core',
  created_at: ISO_EPOCH,
};

/**
 * `prose` — a chunk of rich text. The single `html` field is sanitized at
 * save time and emitted raw (triple-brace) so authored formatting survives.
 */
const prose: BlockType = {
  id: 'core/prose',
  name: 'prose',
  label: 'Text',
  icon: 'type',
  category: 'content',
  container: false,
  schema: [
    { name: 'html', type: 'richtext', label: 'Content' },
    { name: 'max_width', type: 'select', label: 'Max width', options: ['narrow', 'normal', 'wide'], default: 'normal' },
  ],
  template: `<div data-block="prose" data-w="{{max_width}}">{{{html}}}</div>`,
  // Fluid type via clamp() — rubriker och brödtext skalar mellan mobil
  // och desktop utan media queries. Behåller läsbarhet på små skärmar
  // utan att gå för stort på desktop.
  styles: `
[data-block="prose"] { min-width: 0; line-height: 1.65; font-size: clamp(1rem, 0.95rem + 0.25vw, 1.125rem); overflow-wrap: anywhere; }
[data-block="prose"][data-w="narrow"] { max-width: 38rem; margin-inline: auto; }
[data-block="prose"][data-w="wide"] { max-width: 60rem; margin-inline: auto; }
[data-block="prose"] p { margin: 0 0 1em; }
[data-block="prose"] h1 { margin: 1.5em 0 0.5em; font-size: clamp(1.75rem, 1rem + 3.5vw, 3.5rem); line-height: 1.15; }
[data-block="prose"] h2 { margin: 1.5em 0 0.5em; font-size: clamp(1.5rem, 0.875rem + 2.5vw, 2.5rem); line-height: 1.2; }
[data-block="prose"] h3 { margin: 1.5em 0 0.5em; font-size: clamp(1.25rem, 0.75rem + 2vw, 1.75rem); line-height: 1.25; }
[data-block="prose"] h4 { margin: 1.5em 0 0.5em; font-size: clamp(1.125rem, 0.75rem + 1vw, 1.375rem); line-height: 1.3; }
[data-block="prose"] ul, [data-block="prose"] ol { margin: 0 0 1em 1.5em; }
[data-block="prose"] a { color: var(--color-primary, currentColor); overflow-wrap: anywhere; }
[data-block="prose"] a:focus-visible { outline: 2px solid var(--color-primary, currentColor); outline-offset: 2px; }
[data-block="prose"] img { max-width: 100%; height: auto; }
[data-block="prose"] table { display: block; max-width: 100%; overflow-x: auto; border-collapse: collapse; }
[data-block="prose"] th, [data-block="prose"] td { padding: 0.5rem; border: 1px solid color-mix(in srgb, currentColor 16%, transparent); }
`.trim(),
  origin: 'core',
  created_at: ISO_EPOCH,
};

/**
 * `heading` — explicit heading element with semantic level. Separate from
 * prose so the editor can offer per-heading metadata (alignment, eyebrow
 * label) without baking it into prose.
 *
 * `level` controls the semantic element (`<h1>`..`<h6>`). `size` controls
 * the visual scale and is decoupled from level — the common case "this
 * needs to be h1 for SEO but only as big as an h3" is one field change,
 * not a hack. `size: auto` picks a sensible default based on level.
 *
 * All sizes use `clamp()` so they shrink smoothly on mobile without any
 * per-page tuning. The plan to address "headings are too big on mobile"
 * is fluid type by default; per-breakpoint overrides come in Phase 2.
 */
const heading: BlockType = {
  id: 'core/heading',
  name: 'heading',
  label: 'Heading',
  icon: 'heading',
  category: 'content',
  container: false,
  schema: [
    { name: 'text', type: 'text', label: 'Heading text', required: true },
    {
      name: 'level',
      type: 'select',
      label: 'Level (semantic)',
      options: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'],
      default: 'h2',
    },
    {
      name: 'size',
      type: 'select',
      label: 'Visual size',
      options: ['auto', 'sm', 'md', 'lg', 'xl', '2xl', '3xl'],
      default: 'auto',
      responsive: true,
    },
    {
      name: 'align',
      type: 'select',
      label: 'Alignment',
      options: ['left', 'center', 'right'],
      default: 'left',
      responsive: true,
    },
    { name: 'eyebrow', type: 'text', label: 'Eyebrow', placeholder: 'small label above heading' },
  ],
  // {{=level}} substitutes a validated tag name (h1..h6). The renderer
  // falls back to div if level is missing/invalid, so the output is
  // always well-formed.
  template: `<div data-block="heading" data-level="{{level}}" data-size="{{size}}" style="text-align:{{align}}">
  <span class="block-heading-eyebrow">{{eyebrow}}</span>
  <{{=level}} class="block-heading-text">{{text}}</{{=level}}>
</div>`,
  styles: `
[data-block="heading"] { --heading-fs: clamp(1.75rem, 1rem + 3.5vw, 3.5rem); }
[data-block="heading"] .block-heading-eyebrow { display: block; font-size: 0.875rem; text-transform: uppercase; letter-spacing: 0.05em; opacity: 0.7; margin-bottom: 0.25rem; }
[data-block="heading"] .block-heading-eyebrow:empty { display: none; }
[data-block="heading"] .block-heading-text { font-weight: 700; line-height: 1.15; margin: 0; font-size: var(--heading-fs); }

/* Explicit visual size — wins over auto */
[data-block="heading"][data-size="3xl"] { --heading-fs: clamp(2rem,    1rem      + 5vw,   4rem); }
[data-block="heading"][data-size="2xl"] { --heading-fs: clamp(1.75rem, 1rem      + 3.5vw, 3.5rem); }
[data-block="heading"][data-size="xl"]  { --heading-fs: clamp(1.5rem,  0.875rem  + 2.5vw, 2.5rem); }
[data-block="heading"][data-size="lg"]  { --heading-fs: clamp(1.25rem, 0.75rem   + 2vw,   1.75rem); }
[data-block="heading"][data-size="md"]  { --heading-fs: clamp(1.125rem, 0.75rem  + 1vw,   1.375rem); }
[data-block="heading"][data-size="sm"]  { --heading-fs: clamp(1rem,    0.85rem   + 0.5vw, 1.125rem); }

/* size=auto: derive from semantic level */
[data-block="heading"][data-size="auto"][data-level="h1"] { --heading-fs: clamp(2rem,    1rem     + 5vw,   4rem); }
[data-block="heading"][data-size="auto"][data-level="h2"] { --heading-fs: clamp(1.75rem, 1rem     + 3.5vw, 3.5rem); }
[data-block="heading"][data-size="auto"][data-level="h3"] { --heading-fs: clamp(1.5rem,  0.875rem + 2.5vw, 2.5rem); }
[data-block="heading"][data-size="auto"][data-level="h4"] { --heading-fs: clamp(1.25rem, 0.75rem  + 2vw,   1.75rem); }
[data-block="heading"][data-size="auto"][data-level="h5"] { --heading-fs: clamp(1.125rem, 0.75rem + 1vw,   1.375rem); }
[data-block="heading"][data-size="auto"][data-level="h6"] { --heading-fs: clamp(1rem,    0.85rem  + 0.5vw, 1.125rem); }
`.trim(),
  origin: 'core',
  created_at: ISO_EPOCH,
};

/**
 * `image` — single image with optional caption + link. Wraps in <figure>
 * for semantic correctness when a caption is present.
 */
const image: BlockType = {
  id: 'core/image',
  name: 'image',
  label: 'Image',
  icon: 'image',
  category: 'media',
  container: false,
  schema: [
    { name: 'src', type: 'image', label: 'Image', required: true },
    { name: 'alt', type: 'text', label: 'Alt text' },
    { name: 'caption', type: 'text', label: 'Caption' },
    { name: 'link', type: 'url', label: 'Link to (optional)' },
    { name: 'width', type: 'select', label: 'Width', options: ['narrow', 'normal', 'wide', 'full'], default: 'normal' },
    { name: 'radius', type: 'select', label: 'Corner radius', options: ['none', 'md', 'lg', 'xl'], default: 'none' },
  ],
  template: `<figure data-block="image" data-w="{{width}}" data-radius="{{radius}}">
  <a href="{{link}}" class="block-image-link"><img src="{{src}}" alt="{{alt}}" loading="lazy" decoding="async" /></a>
  <figcaption class="block-image-caption">{{caption}}</figcaption>
</figure>`,
  styles: `
[data-block="image"] { margin: 0 auto; }
[data-block="image"][data-w="narrow"] { max-width: 32rem; }
[data-block="image"][data-w="normal"] { max-width: 48rem; }
[data-block="image"][data-w="wide"] { max-width: 64rem; }
[data-block="image"][data-w="full"] { max-width: none; }
[data-block="image"] img { display: block; width: 100%; height: auto; }
[data-block="image"][data-radius="md"] img { border-radius: 0.5rem; }
[data-block="image"][data-radius="lg"] img { border-radius: 1.25rem; }
[data-block="image"][data-radius="xl"] img { border-radius: 1.75rem; }
[data-block="image"] .block-image-link[href=""] { pointer-events: none; }
[data-block="image"] .block-image-caption:empty { display: none; }
[data-block="image"] .block-image-caption { padding: 0.5rem 0; font-size: 0.875rem; opacity: 0.7; text-align: center; }
`.trim(),
  origin: 'core',
  created_at: ISO_EPOCH,
};

/**
 * `button` — single call-to-action button. Style variant + size, optional
 * `open in new tab`.
 */
const button: BlockType = {
  id: 'core/button',
  name: 'button',
  label: 'Button',
  icon: 'mouse-pointer-click',
  category: 'content',
  container: false,
  schema: [
    { name: 'label', type: 'text', label: 'Button text', required: true, default: 'Learn more' },
    { name: 'href', type: 'url', label: 'Link to', required: true },
    { name: 'variant', type: 'select', label: 'Style', options: ['primary', 'secondary', 'ghost'], default: 'primary' },
    { name: 'size', type: 'select', label: 'Size', options: ['sm', 'md', 'lg'], default: 'md' },
    { name: 'new_tab', type: 'boolean', label: 'Open in new tab' },
  ],
  // `new_tab` is a boolean; the renderer escapes it to "true"/"false" — the
  // CSS attribute selector matches "true" to add the target rel attrs via
  // markup substitution? Simpler: render conditionally via empty target if
  // not set. We use a class hook instead.
  template: `<p data-block="button" data-variant="{{variant}}" data-size="{{size}}">
  <a href="{{href}}" class="block-button-link" data-newtab="{{new_tab}}">{{label}}</a>
</p>`,
  styles: `
[data-block="button"] { margin: 1rem 0; }
[data-block="button"] .block-button-link {
  display: inline-block; padding: 0.75rem 1.5rem; border-radius: 0.375rem;
  text-decoration: none; font-weight: 600; transition: opacity 0.15s;
}
[data-block="button"][data-size="sm"] .block-button-link { padding: 0.5rem 1rem; font-size: 0.875rem; }
[data-block="button"][data-size="lg"] .block-button-link { padding: 1rem 2rem; font-size: 1.125rem; }
[data-block="button"][data-variant="primary"] .block-button-link {
  background: var(--color-primary, #111); color: var(--color-primary-fg, #fff);
}
[data-block="button"][data-variant="secondary"] .block-button-link {
  background: var(--color-secondary, #f3f4f6); color: var(--color-secondary-fg, #111);
}
[data-block="button"][data-variant="ghost"] .block-button-link {
  background: transparent; color: var(--color-primary, currentColor);
  border: 1px solid currentColor;
}
[data-block="button"] .block-button-link:hover { opacity: 0.85; }
[data-block="button"] .block-button-link { max-width: 100%; overflow-wrap: anywhere; text-align: center; }
[data-block="button"] .block-button-link:focus-visible { outline: 2px solid var(--color-primary, currentColor); outline-offset: 3px; }
`.trim(),
  origin: 'core',
  created_at: ISO_EPOCH,
};

/**
 * Marker block used inside PageTemplate.blocks to indicate where the
 * consuming page's own blocks render. The renderer's template-composition
 * pass replaces these with the page's `blocks` tree before the normal
 * block render runs.
 *
 * The template here renders nothing — if a `template_content_slot` ever
 * survives composition (e.g. a page is rendered standalone without a
 * template), it falls back to an empty placeholder rather than crashing.
 */
const templateContentSlot: BlockType = {
  id: 'template_content_slot',
  name: 'template_content_slot',
  label: 'Page content',
  icon: 'box-select',
  category: 'layout',
  container: false,
  schema: [],
  template: `<!-- template_content_slot: this should be replaced during composition -->`,
  origin: 'core',
  created_at: ISO_EPOCH,
};

/**
 * The default list, exported in render order for editor block-library
 * grouping (layout → content → media). The editor MAY re-sort by category;
 * the renderer doesn't care about order here.
 */
export const CORE_BLOCK_TYPES: readonly BlockType[] = [
  section,
  columns,
  prose,
  heading,
  image,
  button,
  templateContentSlot,
  // Tier 1 library — see tier1-blocks.ts. Kept separate so the file
  // doesn't grow unwieldy, but merged here so a single registry covers
  // every block ID a page could reference.
  ...TIER1_BLOCK_TYPES,
  // Repeater + aliases — see repeater-blocks.ts. These come after Tier 1
  // because some of them reference Tier 1 item blocks via `expand_to`.
  ...REPEATER_BLOCK_TYPES,
  // Forms 2.0 field blocks (form/*) — see docs/plans/forms-funnels.md
  ...FORM_BLOCK_TYPES,
  // Template/* blocks — read from the dynamic render context
  // (page/site/item). Used inside PageTemplates so a blog template can
  // bind {{page.title}} once and every blog post renders correctly.
  ...TEMPLATE_BLOCK_TYPES,
] as const;

/**
 * Build a registry Map for use with `renderBlocks`. Custom block types
 * (loaded from the per-site block_types collection) should be merged in
 * after this — they override core if ids collide, but core ids are
 * `core/*`-namespaced to make collisions unlikely.
 */
export function buildCoreBlockRegistry(): Map<string, BlockType> {
  const map = new Map<string, BlockType>();
  for (const bt of CORE_BLOCK_TYPES) map.set(bt.id, bt);
  return map;
}
