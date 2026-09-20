import { COLUMN_STACK_BELOW, COLUMN_STACK_CSS, EMPTY_OUTLINE_COLUMN_CSS } from './column-layout.js';
import { pixels, typographyFields, componentBreakpointsField, groupPresentationField } from './presentation-fields.js';
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

import { ARTICLE_BLOCK_TYPES } from './article-blocks.js';
import { REPEATER_BLOCK_TYPES } from './repeater-blocks.js';
import { FORM_BLOCK_TYPES } from './form-blocks.js';
import { TEMPLATE_BLOCK_TYPES } from './template-blocks.js';
import { TIER1_BLOCK_TYPES } from './tier1-blocks.js';
import { FIELD_LIST_BLOCK } from './field-list.js';
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
    pixels('max_width_px', 'Inner maximum width (px)', 240),
    pixels('content_gap_px', 'Space between blocks (px)', 0, 240),
    { name: 'padding_x', type: 'select', label: 'Horizontal padding', options: ['auto', 'none', 'sm', 'md', 'lg'], default: 'auto', responsive: true, responsive_css: { auto: '--section-px:var(--content-gutter,1.25rem);', none: '--section-px:0px;', sm: '--section-px:1rem;', md: '--section-px:2rem;', lg: '--section-px:3rem;' } },
    { name: 'padding_y', type: 'select', label: 'Vertical padding', options: ['auto', 'compact', 'none', 'sm', 'md', 'lg', 'xl'], default: 'auto' },
    { name: 'background', type: 'color', label: 'Background color' },
    { name: 'text_color', type: 'color', label: 'Text color' },
    // Shaped section transitions. The divider is filled with THIS section's
    // own background colour and overlaps the neighbour by 1px — so it never
    // needs to know the adjacent colour and can never leave a hairline seam.
    // Use ONE divider per junction (typically the lower section's top).
    { name: 'divider_top', type: 'select', label: 'Top divider', options: ['none', 'wave', 'curve', 'tilt'], default: 'none' },
    { name: 'divider_bottom', type: 'select', label: 'Bottom divider', options: ['none', 'wave', 'curve', 'tilt'], default: 'none' },
  ],
  template: `<section data-block="section" data-width="{{width}}" data-pad="{{padding_y}}" data-divtop="{{divider_top}}" data-divbot="{{divider_bottom}}" style="--block-bg:{{background}};--block-fg:{{text_color}};--padding_x:{{padding_x}}">
  <span class="block-section-shape block-section-shape--top" aria-hidden="true"></span>
  <div class="block-section-inner">{{children}}</div>
  <span class="block-section-shape block-section-shape--bot" aria-hidden="true"></span>
</section>`,
  styles: `
[data-block="section"] { position: relative; padding: var(--section-padding, 3rem) var(--content-gutter, 1.25rem); background: var(--block-bg, transparent); color: var(--block-fg, inherit); }
[data-block="section"][style*="--padding_x:"] { padding-inline:var(--section-px, var(--content-gutter,1.25rem)); }
[data-block="section"][style*="--padding_x:auto"] { --section-px:var(--content-gutter,1.25rem); }
[data-block="section"][style*="--padding_x:none"] { --section-px:0px; }
[data-block="section"][style*="--padding_x:sm"] { --section-px:1rem; }
[data-block="section"][style*="--padding_x:md"] { --section-px:2rem; }
[data-block="section"][style*="--padding_x:lg"] { --section-px:3rem; }
[data-block="section"][data-pad="compact"] { padding-block:var(--header-padding,1rem); }
[data-block="section"][data-pad="none"] { padding-top: 0; padding-bottom: 0; }
[data-block="section"][data-pad="sm"] { padding-top: 2rem; padding-bottom: 2rem; }
[data-block="section"][data-pad="md"] { padding-top: 4rem; padding-bottom: 4rem; }
[data-block="section"][data-pad="lg"] { padding-top: 6rem; padding-bottom: 6rem; }
[data-block="section"][data-pad="xl"] { padding-top: 8rem; padding-bottom: 8rem; }
[data-block="section"] > .block-section-inner { max-width: var(--max_width_px, 65rem); margin: 0 auto; }
[data-block="section"][data-width="narrow"] > .block-section-inner { max-width: var(--max_width_px, 42rem); }
[data-block="section"][data-width="wide"] > .block-section-inner { max-width: var(--max_width_px, 80rem); }
[data-block="section"][data-width="full"] > .block-section-inner { max-width: var(--max_width_px, none); }
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
    pixels('gap_px', 'Column gap (px)', 0, 240),
    pixels('right_width_px', 'Right column width (px)', 80, 640),
    pixels('left_width_px', 'Left column width (px)', 80, 640),
    { name: 'stack_below_px', type: 'number', label: 'Custom stacking threshold (px)', min: 320, max: 1600 },
    { name: 'stack_below', type: 'select', label: 'Stack below viewport width', options: COLUMN_STACK_BELOW, option_labels: ['721 px (default)', '768 px', '1024 px', '1280 px'], default: '721' },
    { name: 'mobile_order', type: 'select', label: 'Mobile order', options: ['left-first', 'right-first'], default: 'left-first' },
    { name: 'align', type: 'select', label: 'Vertical alignment', options: ['start', 'center', 'end'], default: 'start' },
  ],
  template: `<div data-block="columns" data-stack-below="{{stack_below}}" data-ratio="{{ratio}}" data-gap="{{gap}}" data-align="{{align}}" data-mobile-order="{{mobile_order}}">
  <div class="block-columns-col">{{slot:Left}}</div>
  <div class="block-columns-col">{{slot:Right}}</div>
</div>`,
  styles: `
[data-block="columns"] { display: grid; grid-template-columns: 1fr 1fr; gap: 2rem; }
/* Allow wide tables and other scrollable content to shrink inside a track. */
[data-block="columns"] > .block-columns-col { min-width: 0; }
[data-block="columns"][data-ratio="2-1"] { grid-template-columns: 2fr 1fr; }
[data-block="columns"][data-ratio="1-2"] { grid-template-columns: 1fr 2fr; }
[data-block="columns"][data-ratio="3-1"] { grid-template-columns: 3fr 1fr; }
[data-block="columns"][data-ratio="1-3"] { grid-template-columns: 1fr 3fr; }
[data-block="columns"][data-gap="sm"] { gap: 1rem; }
[data-block="columns"][data-gap="lg"] { gap: 3rem; }
[data-block="columns"][style*="--gap_px:"] { gap:var(--gap_px,2rem); }
[data-block="columns"][style*="--right_width_px:"] { grid-template-columns:minmax(0,1fr) minmax(0,var(--right_width_px,280px)); }
[data-block="columns"][style*="--left_width_px:"] { grid-template-columns:minmax(0,var(--left_width_px,150px)) minmax(0,1fr); }
[data-block="columns"][data-align="center"] { align-items: center; }
[data-block="columns"][data-align="end"] { align-items: end; }
${COLUMN_STACK_CSS}
${EMPTY_OUTLINE_COLUMN_CSS}
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
    ...typographyFields,
    pixels('paragraph_spacing_px', 'Paragraph spacing (px)', 0, 160),
    { name: 'text_align', type: 'select', label: 'Text alignment', options: ['inherit', 'start', 'center', 'end', 'justify'], default: 'inherit', responsive: true },
    { name: 'font_weight', type: 'select', label: 'Text weight', options: ['inherit', '400', '500', '600', '700'], default: 'inherit', responsive: true },
    { name: 'font', type: 'select', label: 'Font family', options: ['inherit', 'body', 'heading'], default: 'inherit' },
    { name: 'max_width', type: 'select', label: 'Max width', options: ['narrow', 'normal', 'wide'], default: 'normal' },
  ],
  template: `<div data-block="prose" data-w="{{max_width}}" data-font="{{font}}" style="--text_align:{{text_align}};--font_weight:{{font_weight}}">{{{html}}}</div>`,
  // Fluid type via clamp() — rubriker och brödtext skalar mellan mobil
  // och desktop utan media queries. Behåller läsbarhet på små skärmar
  // utan att gå för stort på desktop.
  styles: `
[data-block="prose"] { min-width: 0; line-height: var(--line_height, var(--page-body-line-height, 1.65)); font-size: var(--font_size_px, var(--page-body-font-size, clamp(1rem, 0.95rem + 0.25vw, 1.125rem))); text-align:var(--text_align,inherit); font-weight:var(--font_weight,inherit); overflow-wrap: anywhere; }
[data-block="prose"][data-w="narrow"] { max-width: 38rem; margin-inline: auto; }
[data-block="prose"][data-w="wide"] { max-width: 60rem; margin-inline: auto; }
[data-block="prose"] p { margin: 0 0 var(--paragraph_spacing_px,var(--page-body-paragraph-spacing, 1em)); }
[data-block="prose"][data-font="body"] { font-family:var(--font-body,inherit); }
[data-block="prose"][data-font="heading"] { font-family:var(--font-heading,inherit); }
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
    { name: 'anchor_id', type: 'text', label: 'Anchor ID' },
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
      options: ['auto', 'theme', 'article', 'sm', 'md', 'lg', 'xl', '2xl', '3xl'],
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
    { name: 'font_weight', type: 'select', label: 'Font weight', options: ['400', '500', '600', '700', '800'] },
    ...typographyFields,
    { name: 'color', type: 'color', label: 'Text color' },
    { name: 'eyebrow', type: 'text', label: 'Eyebrow', placeholder: 'small label above heading' },
  ],
  // {{=level}} substitutes a validated tag name (h1..h6). The renderer
  // falls back to div if level is missing/invalid, so the output is
  // always well-formed.
  template: `<div data-block="heading" data-level="{{level}}" data-size="{{size}}" data-font-weight="{{font_weight}}" style="text-align:{{align}};--heading-color:{{color}}">
  <span class="block-heading-eyebrow">{{eyebrow}}</span>
  <{{=level}}{{{heading_anchor_attr}}} class="block-heading-text">{{text}}</{{=level}}>
</div>`,
  styles: `
[data-block="heading"] { --heading-fs: clamp(1.75rem, 1rem + 3.5vw, 3.5rem); }
[data-block="heading"] .block-heading-text { color:var(--heading-color,inherit); }
[data-block="heading"] .block-heading-eyebrow { display: block; font-size: 0.875rem; text-transform: uppercase; letter-spacing: 0.05em; opacity: 0.7; margin-bottom: 0.25rem; }
[data-block="heading"] .block-heading-eyebrow:empty { display: none; }
[data-block="heading"]:not([data-size="theme"]) .block-heading-text { font-weight: 700; line-height: 1.15; margin: 0; font-size: var(--heading-fs); }

[data-block="heading"][data-font-weight="400"] .block-heading-text { font-weight:400; }
[data-block="heading"][data-font-weight="500"] .block-heading-text { font-weight:500; }
[data-block="heading"][data-font-weight="600"] .block-heading-text { font-weight:600; }
[data-block="heading"][data-font-weight="700"] .block-heading-text { font-weight:700; }
[data-block="heading"][data-font-weight="800"] .block-heading-text { font-weight:800; }
[data-block="heading"][data-size="auto"] .block-heading-text { line-height:1.25; }
[data-block="heading"][data-size="auto"][data-level="h1"] .block-heading-text { line-height:1.2; }
[data-block="heading"][data-size="auto"][data-level="h3"] .block-heading-text { line-height:1.3; }
[data-block="heading"][data-size="auto"][data-level="h4"] .block-heading-text { line-height:1.35; }
/* Explicit visual size — wins over auto */
[data-block="heading"][data-size="3xl"] { --heading-fs: clamp(2rem,    1rem      + 5vw,   4rem); }
[data-block="heading"][data-size="2xl"] { --heading-fs: clamp(1.75rem, 1rem      + 3.5vw, 3.5rem); }
[data-block="heading"][data-size="xl"]  { --heading-fs: clamp(1.5rem,  0.875rem  + 2.5vw, 2.5rem); }
[data-block="heading"][data-size="lg"]  { --heading-fs: clamp(1.25rem, 0.75rem   + 2vw,   1.75rem); }
[data-block="heading"][data-size="md"]  { --heading-fs: clamp(1.125rem, 0.75rem  + 1vw,   1.375rem); }
[data-block="heading"][data-size="sm"]  { --heading-fs: clamp(1rem,    0.85rem   + 0.5vw, 1.125rem); }

/* size=auto: derive from semantic level */
/* Editorial scale, independent of hero sizing and site CSS. */
[data-block="heading"][data-size="article"] { --heading-fs:clamp(1.25rem, 1rem + 1vw, 1.5rem); }
[data-block="heading"][data-size="article"][data-level="h1"] { --heading-fs:clamp(1.75rem, 1.25rem + 2vw, 2.5rem); }
[data-block="heading"][data-size="article"][data-level="h2"] { --heading-fs:clamp(1.5rem, 1.125rem + 1vw, 2rem); }
[data-block="heading"][data-size="article"] .block-heading-text { line-height:1.2; }
[data-block="heading"][data-size="auto"][data-level="h1"] { --heading-fs: var(--type-h1, 1.75rem); }
[data-block="heading"][data-size="auto"][data-level="h2"] { --heading-fs: var(--type-h2, 1.375rem); }
[data-block="heading"][data-size="auto"][data-level="h3"] { --heading-fs: var(--type-h3, 1.125rem); }
[data-block="heading"][data-size="auto"][data-level="h4"] { --heading-fs: var(--type-h4, 1rem); }
[data-block="heading"][data-size="auto"][data-level="h5"] { --heading-fs: var(--type-h5, 1rem); }
[data-block="heading"][data-size="auto"][data-level="h6"] { --heading-fs: var(--type-h6, .875rem); }
[data-block="heading"][style*="--font_size_px:"] .block-heading-text { font-size:var(--font_size_px, var(--heading-fs)); }
[data-block="heading"][data-level][style*="--line_height:"] .block-heading-text { line-height:var(--line_height,1.2); }
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
    { name: 'fit', type: 'select', label: 'Image fit', options: ['contain', 'cover'], default: 'contain' },
    { name: 'aspect_ratio', type: 'select', label: 'Aspect ratio', options: ['auto', '16:9', '4:3', '1:1', '3:1'], default: 'auto' },
    { name: 'caption', type: 'text', label: 'Caption' },
    { name: 'caption_html', type: 'richtext', label: 'Formatted caption / credit (overrides plain caption)' },
    { name: 'caption_align', type: 'select', label: 'Caption alignment', options: ['left', 'center', 'right'], default: 'center' },
    { name: 'align', type: 'select', label: 'Image alignment', options: ['left', 'center', 'right'], default: 'center' },
    { name: 'max_width', type: 'number', label: 'Maximum width (px)', min: 1 },
    { name: 'original_width', type: 'number', label: 'Original width (px)', min: 1 },
    { name: 'original_height', type: 'number', label: 'Original height (px)', min: 1 },
    { name: 'mobile_src', type: 'image', label: 'Mobile image (optional)' },
    { name: 'link', type: 'url', label: 'Link to (optional)' },
    { name: 'width', type: 'select', label: 'Width', options: ['narrow', 'normal', 'wide', 'full', 'original'], default: 'normal' },
    { name: 'radius', type: 'select', label: 'Corner radius', options: ['none', 'md', 'lg', 'xl'], default: 'none' },
  ],
  template: `<figure data-block="image" data-fit="{{fit}}" data-aspect="{{aspect_ratio}}" data-w="{{width}}" data-align="{{align}}" data-caption-align="{{caption_align}}" data-radius="{{radius}}" style="{{image_size_style}}">
  {{{image_markup}}}
  <figcaption class="block-image-caption">{{{image_caption_html}}}</figcaption>
</figure>`,
  styles: `
[data-block="image"] { margin: 0 auto; width:100%; }
[data-block="image"][data-align="left"] { margin-left:0; }
[data-block="image"][data-align="right"] { margin-right:0; }
[data-block="image"][data-w="original"] img { width:auto; max-width:100%; }
[data-block="image"][data-w="narrow"] { max-width: 32rem; }
[data-block="image"][data-w="normal"] { max-width: 48rem; }
[data-block="image"][data-w="wide"] { max-width: 64rem; }
[data-block="image"][data-w="full"] { max-width: none; }

[data-block="image"][data-fit="cover"] img { object-fit:cover; }
[data-block="image"][data-aspect="16:9"] img { aspect-ratio:16/9; }
[data-block="image"][data-aspect="4:3"] img { aspect-ratio:4/3; }
[data-block="image"][data-aspect="1:1"] img { aspect-ratio:1; }
[data-block="image"][data-aspect="3:1"] img { aspect-ratio:3/1; }
[data-block="image"] img { margin:0; border-radius:0; object-fit:contain; display: block; width: 100%; height: auto; }
[data-block="image"][data-radius="md"] img { border-radius: 0.5rem; }
[data-block="image"][data-radius="lg"] img { border-radius: 1.25rem; }
[data-block="image"][data-radius="xl"] img { border-radius: 1.75rem; }
[data-block="image"] .block-image-link[href=""] { pointer-events: none; }
[data-block="image"][data-caption-align="left"] .block-image-caption { text-align:left; }
[data-block="image"][data-caption-align="right"] .block-image-caption { text-align:right; }
[data-block="image"] .block-image-caption p { margin:0; }
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
  template: `<p data-block="button" data-variant="{{variant}}" data-size="{{size}}">
  <a href="{{href}}" class="block-button-link" {{#button_new_tab}}target="_blank" rel="noopener noreferrer"{{/button_new_tab}}>{{label}}</a>
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
  schema: [
    { name: 'max_width', type: 'select', label: 'Content width', options: ['full', 'narrow', 'normal', 'wide'], default: 'full' },
    { name: 'font_size', type: 'number', label: 'Body text size (px)', min: 12, max: 32, placeholder: 'Block default' },
    { name: 'line_height', type: 'number', label: 'Body line height', min: 1, max: 2.5, placeholder: 'Block default' },
    { name: 'paragraph_spacing', type: 'number', label: 'Paragraph spacing (em)', min: 0, max: 3, placeholder: 'Block default' },
    { name: 'rhythm', type: 'select', label: 'Content spacing', options: ['default', 'article'], default: 'default' },
  ],
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
  FIELD_LIST_BLOCK,
  // Tier 1 library — see tier1-blocks.ts. Kept separate so the file
  // doesn't grow unwieldy, but merged here so a single registry covers
  // every block ID a page could reference.
  ...TIER1_BLOCK_TYPES,
  ...ARTICLE_BLOCK_TYPES,
  // Repeater + aliases — see repeater-blocks.ts. These come after Tier 1
  // because some of them reference Tier 1 item blocks via `expand_to`.
  ...REPEATER_BLOCK_TYPES,
  // Forms 2.0 field blocks (form/*) — see docs/plans/forms-funnels.md
  ...FORM_BLOCK_TYPES,
  // Template/* blocks — read from the dynamic render context
  // (page/site/item). Used inside PageTemplates so a blog template can
  // bind {{page.title}} once and every blog post renders correctly.
  ...TEMPLATE_BLOCK_TYPES,
].map(block => ({ ...block, schema: [...block.schema, componentBreakpointsField].map(groupPresentationField) }));

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
