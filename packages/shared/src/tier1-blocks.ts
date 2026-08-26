// Tier 1 block library — the most-used blocks across CMS / page-builder
// products (Elementor, Breakdance, Gutenberg, popular extensions). Together
// with the seven core blocks in `core-blocks.ts`, this covers the ~95% case
// for landing pages, marketing sites, and blog templates.
//
// All blocks here follow the standardised field naming convention (see
// docs/blocks-plan.md §7) so the editor + AI can reason about them
// uniformly. Layout-sensitive fields are marked `responsive: true` and
// exposed as CSS variables (`--{field-name}`) per the renderer convention.
//
// Item-compatible blocks (`testimonial`, `team_member`, `pricing_plan`,
// `post_card`, `logo_item`, `step_card`) are designed as kernels — they
// have no outer section / padding — so they tile cleanly inside repeaters.
// They render fine standalone too.

import type { BlockType } from './types.js';

const ISO_EPOCH = '1970-01-01T00:00:00Z';

// ─── Layout primitives ───────────────────────────────────────────────────

/**
 * `container` — flex container. Friendlier than `section` when you need
 * direct flex control. Pair with `grid` for tabular layouts.
 */
const container: BlockType = {
  id: 'core/container',
  name: 'container',
  label: 'Container',
  icon: 'box',
  category: 'layout',
  container: true,
  schema: [
    { name: 'direction', type: 'select', label: 'Direction', options: ['row', 'column'], default: 'column', responsive: true },
    { name: 'wrap', type: 'select', label: 'Wrap', options: ['nowrap', 'wrap'], default: 'wrap', responsive: true },
    { name: 'gap', type: 'select', label: 'Gap', options: ['none', 'xs', 'sm', 'md', 'lg', 'xl'], default: 'md', responsive: true },
    { name: 'align_main', type: 'select', label: 'Main-axis alignment',
      options: ['start', 'center', 'end', 'space-between', 'space-around'], default: 'start', responsive: true },
    { name: 'align_cross', type: 'select', label: 'Cross-axis alignment',
      options: ['start', 'center', 'end', 'stretch'], default: 'stretch', responsive: true },
    { name: 'width', type: 'select', label: 'Width', options: ['narrow', 'normal', 'wide', 'full'], default: 'normal' },
    { name: 'padding_y', type: 'select', label: 'Vertical padding', options: ['none', 'sm', 'md', 'lg', 'xl'], default: 'md', responsive: true },
    { name: 'padding_x', type: 'select', label: 'Horizontal padding', options: ['none', 'sm', 'md', 'lg', 'xl'], default: 'md', responsive: true },
    { name: 'background', type: 'color', label: 'Background color' },
    { name: 'background_image', type: 'image', label: 'Background image' },
    { name: 'min_height', type: 'select', label: 'Minimum height', options: ['auto', 'sm', 'md', 'lg', 'screen'], default: 'auto' },
  ],
  // Convention: every `responsive: true` field is exposed as a CSS var
  // named `--{field-name}` so the @media compiler can override it cleanly.
  // Layout-control CSS reads `var(--gap)` etc. and maps the token (sm/md/lg)
  // to a real rem value via attribute-selectors against the inline style.
  template: `<div data-block="container" data-width="{{width}}" data-min-h="{{min_height}}" style="--direction:{{direction}};--wrap:{{wrap}};--gap:{{gap}};--align_main:{{align_main}};--align_cross:{{align_cross}};--padding_y:{{padding_y}};--padding_x:{{padding_x}};--bg:{{background}};--bg-image:url({{background_image}})">{{children}}</div>`,
  styles: `
[data-block="container"] {
  display: flex; flex-direction: var(--direction, column); flex-wrap: var(--wrap, wrap);
  gap: var(--block-gap, 1rem); justify-content: var(--align_main, flex-start); align-items: var(--align_cross, stretch);
  padding-block: var(--block-py, 2rem); padding-inline: var(--block-px, 1rem);
  background: var(--bg, transparent);
}
[data-block="container"][style*="--bg-image:url("] { background-image: var(--bg-image); background-size: cover; background-position: center; }
[data-block="container"][data-width="narrow"] { max-width: 42rem; margin-inline: auto; }
[data-block="container"][data-width="normal"] { max-width: 65rem; margin-inline: auto; }
[data-block="container"][data-width="wide"]   { max-width: 80rem; margin-inline: auto; }
[data-block="container"][data-width="full"]   { max-width: none; }
[data-block="container"][data-min-h="sm"]     { min-height: 30vh; }
[data-block="container"][data-min-h="md"]     { min-height: 50vh; }
[data-block="container"][data-min-h="lg"]     { min-height: 70vh; }
[data-block="container"][data-min-h="screen"] { min-height: 100vh; }
[data-block="container"][style*="--gap:none"]       { --block-gap: 0; }
[data-block="container"][style*="--gap:xs"]         { --block-gap: 0.25rem; }
[data-block="container"][style*="--gap:sm"]         { --block-gap: 0.5rem; }
[data-block="container"][style*="--gap:md"]         { --block-gap: 1rem; }
[data-block="container"][style*="--gap:lg"]         { --block-gap: 2rem; }
[data-block="container"][style*="--gap:xl"]         { --block-gap: 3rem; }
[data-block="container"][style*="--padding_y:none"] { --block-py: 0; }
[data-block="container"][style*="--padding_y:sm"]   { --block-py: 2rem; }
[data-block="container"][style*="--padding_y:md"]   { --block-py: 4rem; }
[data-block="container"][style*="--padding_y:lg"]   { --block-py: 6rem; }
[data-block="container"][style*="--padding_y:xl"]   { --block-py: 8rem; }
[data-block="container"][style*="--padding_x:none"] { --block-px: 0; }
[data-block="container"][style*="--padding_x:sm"]   { --block-px: 0.5rem; }
[data-block="container"][style*="--padding_x:md"]   { --block-px: 1rem; }
[data-block="container"][style*="--padding_x:lg"]   { --block-px: 2rem; }
[data-block="container"][style*="--padding_x:xl"]   { --block-px: 3rem; }
`.trim(),
  origin: 'core',
  created_at: ISO_EPOCH,
};

/**
 * `grid` — N-column grid that wraps automatically. The most-used layout
 * after section: 3-up feature lists, 4-up logo rows, 2-up image / text
 * pairs. Pairs naturally with `repeater` for collection lists.
 */
const grid: BlockType = {
  id: 'core/grid',
  name: 'grid',
  label: 'Grid',
  icon: 'layout-grid',
  category: 'layout',
  container: true,
  schema: [
    { name: 'cols', type: 'number', label: 'Columns', default: 3, min: 1, max: 6, responsive: true },
    { name: 'gap', type: 'select', label: 'Gap', options: ['none', 'xs', 'sm', 'md', 'lg', 'xl'], default: 'md', responsive: true },
    { name: 'align', type: 'select', label: 'Alignment', options: ['start', 'center', 'end', 'stretch'], default: 'stretch', responsive: true },
    {
      name: 'stack_at',
      type: 'select',
      label: 'Stack at',
      options: ['sm', 'md', 'lg'],
      default: 'sm',
    },
    {
      // 'center' switches the grid to flex columns so a partial last row
      // (5 cards in 3 cols, 7 in 4, ...) auto-centers instead of leaving
      // left-aligned orphans. The right answer for N equal peer cards
      // where N doesn't divide by cols — never invent a "wide" variant
      // of a peer card just to fill the row.
      name: 'last_row',
      type: 'select',
      label: 'Last row alignment',
      options: ['start', 'center'],
      default: 'start',
    },
  ],
  template: `<div data-block="grid" data-stack-at="{{stack_at}}" data-last-row="{{last_row}}" style="--cols:{{cols}};--gap:{{gap}};--align:{{align}}">{{children}}</div>`,
  styles: `
[data-block="grid"] {
  display: grid;
  /* Read --cols DIRECTLY (not a substring-mapped --block-cols): the
     responsive @media compiler overrides --cols per breakpoint, and an
     attribute-substring selector can't see those computed overrides — only
     the static inline value. Reading the variable is necessary but NOT
     sufficient: because the baseline --cols is inline, the @media overrides
     (both the responsive compiler's and stack_at below) must be !important
     to win the cascade. */
  grid-template-columns: repeat(var(--cols, 3), minmax(0, 1fr));
  gap: var(--block-gap, 1rem);
  align-items: var(--align, stretch);
}
/* last_row:center — flex columns so a partial last row auto-centers.
   flex-basis reproduces the equal-column widths from --cols, so the
   responsive cols overrides and stack_at media rules keep working. */
[data-block="grid"][data-last-row="center"] {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
}
[data-block="grid"][data-last-row="center"] > * {
  flex: 0 0 calc((100% - (var(--cols, 3) - 1) * var(--block-gap, 1rem)) / var(--cols, 3));
  min-width: 0;
  /* grid tracks equalized row heights; in flex that job belongs to the
     line's align stretch — a child height:100% (the grid-ism) breaks it */
  height: auto;
}
[data-block="grid"][style*="--gap:none"] { --block-gap: 0; }
[data-block="grid"][style*="--gap:xs"]   { --block-gap: 0.25rem; }
[data-block="grid"][style*="--gap:sm"]   { --block-gap: 0.5rem; }
[data-block="grid"][style*="--gap:md"]   { --block-gap: 1rem; }
[data-block="grid"][style*="--gap:lg"]   { --block-gap: 2rem; }
[data-block="grid"][style*="--gap:xl"]   { --block-gap: 3rem; }
/* stack_at — collapse to one column below a width. Only for grids WITHOUT
   per-instance responsive cols (:not([data-bid])); when the author set
   responsive cols, those @media overrides own the column count instead.
   !important is REQUIRED: the column count rides on an inline style=--cols:N
   baseline, and an inline custom property outranks any stylesheet rule — so a
   plain non-important --cols:1 here is shadowed by the inline value and the
   grid never collapses. (Verified in-browser.) */
@media (max-width: 720px) {
  [data-block="grid"][data-stack-at="sm"]:not([data-bid]),
  [data-block="grid"]:not([data-stack-at]):not([data-bid]) { --cols: 1 !important; }
}
@media (max-width: 900px) {
  [data-block="grid"][data-stack-at="md"]:not([data-bid]) { --cols: 1 !important; }
}
@media (max-width: 1000px) {
  [data-block="grid"][data-stack-at="lg"]:not([data-bid]) { --cols: 1 !important; }
}
`.trim(),
  origin: 'core',
  created_at: ISO_EPOCH,
};

/**
 * `spacer` — pure vertical whitespace. Used to break up sections without
 * adjusting block margins.
 */
const spacer: BlockType = {
  id: 'core/spacer',
  name: 'spacer',
  label: 'Spacer',
  icon: 'arrows-vertical',
  category: 'layout',
  container: false,
  schema: [
    { name: 'height', type: 'select', label: 'Height', options: ['xs', 'sm', 'md', 'lg', 'xl', '2xl'], default: 'md', responsive: true },
  ],
  template: `<div data-block="spacer" aria-hidden="true" style="--height:{{height}}"></div>`,
  styles: `
[data-block="spacer"]                          { height: 1rem; }
[data-block="spacer"][style*="--height:xs"]    { height: 0.5rem; }
[data-block="spacer"][style*="--height:sm"]    { height: 1rem; }
[data-block="spacer"][style*="--height:md"]    { height: 2rem; }
[data-block="spacer"][style*="--height:lg"]    { height: 4rem; }
[data-block="spacer"][style*="--height:xl"]    { height: 6rem; }
[data-block="spacer"][style*="--height:2xl"]   { height: 8rem; }
`.trim(),
  origin: 'core',
  created_at: ISO_EPOCH,
};

/**
 * `divider` — horizontal rule with style variants. Use over a spacer when
 * the visual break should be explicit (between sections that aren't a
 * different colour).
 */
const divider: BlockType = {
  id: 'core/divider',
  name: 'divider',
  label: 'Divider',
  icon: 'minus',
  category: 'layout',
  container: false,
  schema: [
    { name: 'style', type: 'select', label: 'Line style', options: ['solid', 'dashed', 'dotted'], default: 'solid' },
    { name: 'width', type: 'select', label: 'Width', options: ['full', 'narrow', 'normal'], default: 'full' },
    { name: 'color', type: 'color', label: 'Color' },
    { name: 'thickness', type: 'select', label: 'Thickness', options: ['1px', '2px', '4px', '8px'], default: '1px' },
    { name: 'align', type: 'select', label: 'Alignment', options: ['left', 'center', 'right'], default: 'center' },
  ],
  template: `<hr data-block="divider" data-w="{{width}}" data-align="{{align}}" style="--color:{{color}};--thickness:{{thickness}};--style:{{style}}" />`,
  styles: `
[data-block="divider"] {
  border: none; height: 0;
  border-top: var(--thickness, 1px) var(--style, solid) var(--color, currentColor);
  opacity: 0.3; margin: 1.5rem 0;
}
[data-block="divider"][data-w="narrow"][data-align="left"]   { width: 6rem; margin-right: auto; }
[data-block="divider"][data-w="narrow"][data-align="center"] { width: 6rem; margin-inline: auto; }
[data-block="divider"][data-w="narrow"][data-align="right"]  { width: 6rem; margin-left: auto; }
[data-block="divider"][data-w="normal"][data-align="left"]   { width: 16rem; margin-right: auto; }
[data-block="divider"][data-w="normal"][data-align="center"] { width: 16rem; margin-inline: auto; }
[data-block="divider"][data-w="normal"][data-align="right"]  { width: 16rem; margin-left: auto; }
`.trim(),
  origin: 'core',
  created_at: ISO_EPOCH,
};

// ─── Content primitives ──────────────────────────────────────────────────

/**
 * `icon` — standalone icon. Renders as `<svg>` from an icon library at
 * build time (Lucide). For now, until the icon-name → SVG renderer is
 * wired into the build pipeline, the renderer emits a `data-icon="{name}"`
 * attribute and a `<svg>` placeholder; the site-template's runtime
 * resolver substitutes the actual path.
 */
const icon: BlockType = {
  id: 'core/icon',
  name: 'icon',
  label: 'Icon',
  icon: 'star',
  category: 'content',
  container: false,
  schema: [
    { name: 'icon', type: 'icon', label: 'Icon' },
    { name: 'size', type: 'select', label: 'Size', options: ['sm', 'md', 'lg', 'xl'], default: 'md', responsive: true },
    { name: 'color', type: 'color', label: 'Color' },
    { name: 'align', type: 'select', label: 'Alignment', options: ['left', 'center', 'right'], default: 'left', responsive: true },
    { name: 'link', type: 'url', label: 'Link to (optional)' },
  ],
  template: `<span data-block="icon" data-icon="{{icon}}" style="--size:{{size}};--align:{{align}};--color:{{color}}"><a href="{{link}}" class="block-icon-link">{{{icon_svg}}}</a></span>`,
  styles: `
[data-block="icon"] { display: inline-flex; align-items: center; color: var(--color, currentColor); }
[data-block="icon"][style*="--align:center"] { display: flex; justify-content: center; }
[data-block="icon"][style*="--align:right"]  { display: flex; justify-content: flex-end; }
[data-block="icon"][style*="--size:sm"] { font-size: 1rem; }
[data-block="icon"][style*="--size:md"] { font-size: 1.5rem; }
[data-block="icon"][style*="--size:lg"] { font-size: 2rem; }
[data-block="icon"][style*="--size:xl"] { font-size: 3rem; }
[data-block="icon"] .block-icon-link[href=""] { pointer-events: none; }
[data-block="icon"] svg { width: 1em; height: 1em; }
`.trim(),
  origin: 'core',
  created_at: ISO_EPOCH,
};

/**
 * `icon_box` — the canonical "feature" card: icon + heading + body + link.
 * The most-tiled block on marketing pages. Item-compatible so it slots
 * into a repeater for 3-up / 4-up feature grids without modification.
 */
const iconBox: BlockType = {
  id: 'core/icon_box',
  name: 'icon_box',
  label: 'Icon Box',
  icon: 'square-stack',
  category: 'content',
  container: false,
  item_compatible: true,
  schema: [
    { name: 'icon', type: 'icon', label: 'Icon' },
    { name: 'icon_style', type: 'select', label: 'Icon style',
      options: ['outline', 'filled', 'circle-bg', 'square-bg'], default: 'outline' },
    { name: 'icon_color', type: 'color', label: 'Icon color' },
    { name: 'icon_bg', type: 'color', label: 'Icon background' },
    { name: 'heading', type: 'text', label: 'Heading' },
    { name: 'heading_level', type: 'select', label: 'Heading level', options: ['h2', 'h3', 'h4', 'h5'], default: 'h3' },
    { name: 'text', type: 'richtext', label: 'Body text' },
    { name: 'link', type: 'url', label: 'Link to' },
    { name: 'link_label', type: 'text', label: 'Link label', default: 'Learn more' },
    { name: 'layout', type: 'select', label: 'Layout', options: ['icon-top', 'icon-left', 'icon-right'], default: 'icon-top', responsive: true,
      // Token → flex-direction. The mobile baseline is handled by the
      // [style*="--layout:…"] rules below; these drive the per-breakpoint
      // overrides (icon-top on mobile, icon-left on tablet, …).
      responsive_css: { 'icon-top': '--layout-dir: column;', 'icon-left': '--layout-dir: row;', 'icon-right': '--layout-dir: row-reverse;' } },
    { name: 'align', type: 'select', label: 'Alignment', options: ['left', 'center'], default: 'left', responsive: true,
      responsive_css: { 'left': '--align-text: left; --align-items: flex-start;', 'center': '--align-text: center; --align-items: center;' } },
  ],
  template: `<div data-block="icon_box" data-icon-style="{{icon_style}}" style="--layout:{{layout}};--align:{{align}};--icon-color:{{icon_color}};--icon-bg:{{icon_bg}}">
  <div class="block-iconbox-icon" data-icon="{{icon}}">{{{icon_svg}}}</div>
  <div class="block-iconbox-body">
    <{{=heading_level}} class="block-iconbox-heading">{{heading}}</{{=heading_level}}>
    <div class="block-iconbox-text">{{{text}}}</div>
    <a href="{{link}}" class="block-iconbox-link">{{link_label}}</a>
  </div>
</div>`,
  styles: `
[data-block="icon_box"] {
  display: flex; gap: 1rem;
  flex-direction: var(--layout-dir, column);
  text-align: var(--align-text, left);
  align-items: var(--align-items, flex-start);
}
[data-block="icon_box"][style*="--layout:icon-top"]   { --layout-dir: column; }
[data-block="icon_box"][style*="--layout:icon-left"]  { --layout-dir: row; }
[data-block="icon_box"][style*="--layout:icon-right"] { --layout-dir: row-reverse; }
[data-block="icon_box"][style*="--align:center"]      { --align-text: center; --align-items: center; }
[data-block="icon_box"] .block-iconbox-icon {
  flex: 0 0 auto; width: 3rem; height: 3rem; display: flex; align-items: center; justify-content: center;
  color: var(--icon-color, var(--color-primary, currentColor));
  font-size: 2rem;
}
[data-block="icon_box"][data-icon-style="circle-bg"] .block-iconbox-icon { border-radius: 50%; background: var(--icon-bg, rgba(0,0,0,0.05)); }
[data-block="icon_box"][data-icon-style="square-bg"] .block-iconbox-icon { border-radius: 0.5rem; background: var(--icon-bg, rgba(0,0,0,0.05)); }
[data-block="icon_box"] .block-iconbox-heading { margin: 0 0 0.25rem; font-size: 1.25rem; font-weight: 600; line-height: 1.3; }
[data-block="icon_box"] .block-iconbox-text { line-height: 1.5; opacity: 0.85; }
[data-block="icon_box"] .block-iconbox-link { display: inline-block; margin-top: 0.5rem; color: var(--color-primary, currentColor); font-weight: 600; }
[data-block="icon_box"] .block-iconbox-link[href=""] { display: none; }
[data-block="icon_box"] .block-iconbox-text:empty { display: none; }
`.trim(),
  origin: 'core',
  created_at: ISO_EPOCH,
};

// ─── Marketing blocks ────────────────────────────────────────────────────

/**
 * `hero` — top-of-page hero with eyebrow + heading + subheading + buttons.
 * Supports four layouts (split left/right, centered, full-image) — the
 * pattern that covers every landing page from "B2B SaaS clean" to
 * "agency editorial".
 */
const hero: BlockType = {
  id: 'core/hero',
  name: 'hero',
  label: 'Hero',
  icon: 'panel-top',
  category: 'layout',
  container: false,
  schema: [
    { name: 'eyebrow', type: 'text', label: 'Eyebrow' },
    { name: 'heading', type: 'text', label: 'Heading' },
    { name: 'subheading', type: 'richtext', label: 'Subheading' },
    // Server-rendered button pair. The old `buttons` array relied on a
    // client-side hydration pipeline that never shipped (empty
    // data-buttons divs in production) — two explicit buttons cover the
    // real-world cases and render with zero JS. Leave a label empty to
    // hide that button.
    { name: 'primary_label', type: 'text', label: 'Primary button label' },
    { name: 'primary_url', type: 'url', label: 'Primary button link' },
    { name: 'secondary_label', type: 'text', label: 'Secondary button label' },
    { name: 'secondary_url', type: 'url', label: 'Secondary button link' },
    { name: 'image', type: 'image', label: 'Image' },
    { name: 'video_url', type: 'url', label: 'Video URL (optional)' },
    { name: 'layout', type: 'select', label: 'Layout',
      options: ['split-left', 'split-right', 'centered', 'full-image'], default: 'centered', responsive: true },
    { name: 'height', type: 'select', label: 'Height', options: ['auto', 'half-screen', 'screen'], default: 'auto' },
    { name: 'overlay_opacity', type: 'number', label: 'Overlay opacity (0-100)', default: 0, min: 0, max: 100 },
    { name: 'background', type: 'color', label: 'Background color' },
  ],
  template: `<section data-block="hero" data-height="{{height}}" style="--layout:{{layout}};--bg:{{background}};--overlay:{{overlay_opacity}}%;--bg-image:url({{image}})">
  <div class="block-hero-inner">
    <div class="block-hero-text">
      <span class="block-hero-eyebrow">{{eyebrow}}</span>
      <h1 class="block-hero-heading">{{heading}}</h1>
      <div class="block-hero-sub">{{{subheading}}}</div>
      <div class="block-hero-actions">
        <a class="block-btn block-btn-primary" href="{{primary_url}}">{{primary_label}}</a>
        <a class="block-btn block-btn-secondary" href="{{secondary_url}}">{{secondary_label}}</a>
      </div>
    </div>
    <div class="block-hero-media">
      <img src="{{image}}" alt="" loading="eager" />
    </div>
  </div>
  <div class="block-hero-overlay" aria-hidden="true"></div>
</section>`,
  styles: `
[data-block="hero"] {
  position: relative; padding: 4rem 1rem; background: var(--bg, transparent); overflow: hidden;
}
[data-block="hero"][data-height="half-screen"] { min-height: 50vh; display: flex; align-items: center; }
[data-block="hero"][data-height="screen"]      { min-height: 100vh; display: flex; align-items: center; }
[data-block="hero"] .block-hero-inner {
  max-width: 65rem; margin: 0 auto; display: grid; grid-template-columns: 1fr 1fr; gap: 3rem; align-items: center;
  position: relative; z-index: 2;
}
[data-block="hero"][style*="--layout:centered"] .block-hero-inner { grid-template-columns: 1fr; text-align: center; }
[data-block="hero"][style*="--layout:centered"] .block-hero-media,
[data-block="hero"][style*="--layout:full-image"] .block-hero-media { grid-column: 1 / -1; }
[data-block="hero"][style*="--layout:split-right"] .block-hero-text  { order: 2; }
[data-block="hero"][style*="--layout:split-right"] .block-hero-media { order: 1; }
[data-block="hero"][style*="--layout:full-image"] {
  background-size: cover; background-position: center;
}
[data-block="hero"][style*="--layout:full-image"]:not([style*="--bg-image:url()"]) { background-image: var(--bg-image); color: white; }
[data-block="hero"][style*="--layout:full-image"] .block-hero-text  { max-width: 36rem; }
[data-block="hero"][style*="--layout:full-image"] .block-hero-media { display: none; }
[data-block="hero"] .block-hero-overlay { position: absolute; inset: 0; background: rgba(0,0,0,0.5); opacity: var(--overlay, 0); z-index: 1; }
[data-block="hero"] .block-hero-eyebrow {
  display: inline-block; font-size: 0.875rem; text-transform: uppercase; letter-spacing: 0.05em;
  opacity: 0.7; margin-bottom: 0.5rem;
}
[data-block="hero"] .block-hero-eyebrow:empty { display: none; }
[data-block="hero"] .block-hero-heading { font-size: clamp(2rem, 1rem + 5vw, 4rem); margin: 0 0 1rem; font-weight: 700; line-height: 1.15; }
[data-block="hero"] .block-hero-sub     { font-size: clamp(1rem, 0.875rem + 0.5vw, 1.25rem); line-height: 1.5; opacity: 0.85; margin-bottom: 1.5rem; }
[data-block="hero"] .block-hero-media img { width: 100%; height: auto; border-radius: 0.5rem; }
[data-block="hero"] .block-hero-media:has(img[src=""]) { display: none; }
@media (max-width: 767px) {
  [data-block="hero"] .block-hero-inner { grid-template-columns: 1fr; gap: 2rem; }
  [data-block="hero"] .block-hero-media { order: 2 !important; }
  [data-block="hero"] .block-hero-text  { order: 1 !important; }
}
[data-block="hero"] .block-hero-actions { display: flex; gap: 0.75rem; flex-wrap: wrap; }
[data-block="hero"] .block-btn { display: inline-block; padding: 0.75rem 1.75rem; border-radius: 999px; font-weight: 600; text-decoration: none; }
[data-block="hero"] .block-btn-primary { background: var(--color-primary, #111); color: var(--color-primary-fg, #fff); }
[data-block="hero"] .block-btn-secondary { background: transparent; color: var(--color-primary, #111); box-shadow: inset 0 0 0 2px currentColor; }
[data-block="hero"] .block-btn:empty { display: none; }
`.trim(),
  origin: 'core',
  created_at: ISO_EPOCH,
};

/**
 * `cta` — call-to-action band. Heading + subheading + buttons, optionally
 * over an image background. Smaller than `hero`; lands between content
 * sections to direct the visitor toward the conversion action.
 */
const cta: BlockType = {
  id: 'core/cta',
  name: 'cta',
  label: 'CTA',
  icon: 'megaphone',
  category: 'content',
  container: false,
  schema: [
    { name: 'eyebrow', type: 'text', label: 'Eyebrow' },
    { name: 'heading', type: 'text', label: 'Heading' },
    { name: 'subheading', type: 'richtext', label: 'Subheading' },
    // Server-rendered button pair. The old `buttons` array relied on a
    // client-side hydration pipeline that never shipped (empty
    // data-buttons divs in production) — two explicit buttons cover the
    // real-world cases and render with zero JS. Leave a label empty to
    // hide that button.
    { name: 'primary_label', type: 'text', label: 'Primary button label' },
    { name: 'primary_url', type: 'url', label: 'Primary button link' },
    { name: 'secondary_label', type: 'text', label: 'Secondary button label' },
    { name: 'secondary_url', type: 'url', label: 'Secondary button link' },
    { name: 'background', type: 'color', label: 'Background color' },
    { name: 'background_image', type: 'image', label: 'Background image' },
    { name: 'align', type: 'select', label: 'Alignment', options: ['left', 'center'], default: 'center', responsive: true },
    { name: 'image_position', type: 'select', label: 'Image position', options: ['none', 'left', 'right', 'background'], default: 'none' },
  ],
  template: `<section data-block="cta" data-image-pos="{{image_position}}" style="--align:{{align}};--bg:{{background}};--bg-image:url({{background_image}})">
  <div class="block-cta-inner">
    <span class="block-cta-eyebrow">{{eyebrow}}</span>
    <h2 class="block-cta-heading">{{heading}}</h2>
    <div class="block-cta-sub">{{{subheading}}}</div>
    <div class="block-cta-actions">
      <a class="block-btn block-btn-primary" href="{{primary_url}}">{{primary_label}}</a>
      <a class="block-btn block-btn-secondary" href="{{secondary_url}}">{{secondary_label}}</a>
    </div>
  </div>
</section>`,
  styles: `
[data-block="cta"] {
  padding: 4rem 1.5rem; background: var(--bg, var(--color-primary, #111));
  color: var(--color-primary-fg, white); text-align: var(--align, center);
}
[data-block="cta"][data-image-pos="background"] { background-image: var(--bg-image); background-size: cover; background-position: center; }
[data-block="cta"] .block-cta-inner { max-width: 48rem; margin-inline: auto; }
[data-block="cta"][style*="--align:left"] .block-cta-inner { margin-inline: 0; max-width: 65rem; }
[data-block="cta"] .block-cta-eyebrow { display: inline-block; font-size: 0.875rem; text-transform: uppercase; letter-spacing: 0.05em; opacity: 0.7; margin-bottom: 0.5rem; }
[data-block="cta"] .block-cta-eyebrow:empty { display: none; }
[data-block="cta"] .block-cta-heading { font-size: clamp(1.5rem, 0.875rem + 2.5vw, 2.5rem); margin: 0 0 1rem; font-weight: 700; line-height: 1.2; }
[data-block="cta"] .block-cta-sub     { margin-bottom: 1.5rem; opacity: 0.85; }
[data-block="cta"] .block-cta-actions { display: flex; gap: 0.75rem; justify-content: var(--align-actions, center); flex-wrap: wrap; }
[data-block="cta"][style*="--align:left"] .block-cta-actions { justify-content: flex-start; }
[data-block="cta"] .block-btn { display: inline-block; padding: 0.75rem 1.75rem; border-radius: 999px; font-weight: 600; text-decoration: none; }
[data-block="cta"] .block-btn-primary { background: var(--color-primary-fg, #fff); color: var(--color-primary, #111); }
[data-block="cta"] .block-btn-secondary { background: transparent; color: inherit; box-shadow: inset 0 0 0 2px currentColor; }
[data-block="cta"] .block-btn:empty { display: none; }
`.trim(),
  origin: 'core',
  created_at: ISO_EPOCH,
};

// ─── Item-compatible blocks (designed for use inside repeaters) ─────────

/**
 * `testimonial` — single quote card with author + role + company. Designed
 * as an item-block so it tiles into a testimonials grid / carousel via
 * `repeater`. Renders fine standalone too.
 */
const testimonial: BlockType = {
  id: 'core/testimonial',
  name: 'testimonial',
  label: 'Testimonial',
  icon: 'quote',
  category: 'content',
  container: false,
  item_compatible: true,
  schema: [
    { name: 'quote', type: 'richtext', label: 'Quote', required: true },
    { name: 'name', type: 'text', label: 'Name' },
    { name: 'role', type: 'text', label: 'Role / title' },
    { name: 'company', type: 'text', label: 'Company' },
    { name: 'avatar', type: 'image', label: 'Avatar' },
    { name: 'logo', type: 'image', label: 'Company logo' },
    { name: 'rating', type: 'number', label: 'Rating (0-5)', min: 0, max: 5 },
    { name: 'style', type: 'select', label: 'Style', options: ['card', 'bordered', 'minimal'], default: 'card' },
  ],
  template: `<figure data-block="testimonial" data-style="{{style}}">
  <blockquote class="block-testimonial-quote">{{{quote}}}</blockquote>
  <figcaption class="block-testimonial-cite">
    <img class="block-testimonial-avatar" src="{{avatar}}" alt="" />
    <div class="block-testimonial-meta">
      <span class="block-testimonial-name">{{name}}</span>
      <span class="block-testimonial-role">{{role}}<span class="block-testimonial-sep">, </span>{{company}}</span>
    </div>
    <img class="block-testimonial-logo" src="{{logo}}" alt="{{company}}" />
  </figcaption>
</figure>`,
  styles: `
[data-block="testimonial"] {
  margin: 0; padding: 1.5rem; line-height: 1.5;
  background: var(--color-bg-subtle, #f9fafb); border-radius: 0.75rem;
  display: flex; flex-direction: column; gap: 1rem;
}
[data-block="testimonial"][data-style="bordered"] { background: transparent; border: 1px solid currentColor; }
[data-block="testimonial"][data-style="minimal"]  { background: transparent; padding: 0.5rem 0; }
[data-block="testimonial"] .block-testimonial-quote { margin: 0; font-size: 1.125rem; }
[data-block="testimonial"] .block-testimonial-cite  { display: flex; gap: 0.75rem; align-items: center; font-size: 0.875rem; }
[data-block="testimonial"] .block-testimonial-avatar { width: 2.5rem; height: 2.5rem; border-radius: 50%; object-fit: cover; }
[data-block="testimonial"] .block-testimonial-avatar[src=""] { display: none; }
[data-block="testimonial"] .block-testimonial-meta  { display: flex; flex-direction: column; }
[data-block="testimonial"] .block-testimonial-name  { font-weight: 600; }
[data-block="testimonial"] .block-testimonial-role  { opacity: 0.7; }
[data-block="testimonial"] .block-testimonial-role:has(.block-testimonial-sep:empty) .block-testimonial-sep { display: none; }
[data-block="testimonial"] .block-testimonial-logo { max-height: 1.5rem; margin-left: auto; opacity: 0.6; }
[data-block="testimonial"] .block-testimonial-logo[src=""] { display: none; }
`.trim(),
  origin: 'core',
  created_at: ISO_EPOCH,
};

/**
 * `team_member` — person card. Photo + name + role + bio + socials. Item-
 * compatible so a team page is a `grid` (or `repeater + grid layout`) of
 * `team_member` items.
 */
const teamMember: BlockType = {
  id: 'core/team_member',
  name: 'team_member',
  label: 'Team Member',
  icon: 'user',
  category: 'content',
  container: false,
  item_compatible: true,
  schema: [
    { name: 'name', type: 'text', label: 'Name', required: true },
    { name: 'role', type: 'text', label: 'Role' },
    { name: 'bio', type: 'richtext', label: 'Bio' },
    { name: 'photo', type: 'image', label: 'Photo' },
    { name: 'socials', type: 'array', label: 'Social links',
      fields: [
        { name: 'network', type: 'select', label: 'Network',
          options: ['twitter', 'linkedin', 'github', 'instagram', 'facebook', 'youtube', 'website', 'email'] },
        { name: 'url', type: 'url', label: 'URL' },
      ] },
    { name: 'link', type: 'url', label: 'Profile link' },
    { name: 'layout', type: 'select', label: 'Layout', options: ['card', 'overlay', 'minimal'], default: 'card' },
  ],
  template: `<div data-block="team_member" data-layout="{{layout}}">
  <a href="{{link}}" class="block-team-link">
    <img class="block-team-photo" src="{{photo}}" alt="{{name}}" />
    <div class="block-team-body">
      <h3 class="block-team-name">{{name}}</h3>
      <span class="block-team-role">{{role}}</span>
      <div class="block-team-bio">{{{bio}}}</div>
      <div class="block-team-socials" data-socials="{{socials}}"></div>
    </div>
  </a>
</div>`,
  styles: `
[data-block="team_member"] { text-align: center; }
[data-block="team_member"] .block-team-link { color: inherit; text-decoration: none; display: block; }
[data-block="team_member"] .block-team-link[href=""] { pointer-events: none; }
[data-block="team_member"] .block-team-photo { width: 100%; aspect-ratio: 1; object-fit: cover; border-radius: 0.5rem; margin-bottom: 0.75rem; background: var(--color-bg-subtle, #f3f4f6); }
[data-block="team_member"] .block-team-photo[src=""] { display: none; }
[data-block="team_member"] .block-team-name { margin: 0 0 0.125rem; font-size: 1.125rem; font-weight: 600; }
[data-block="team_member"] .block-team-role { display: block; opacity: 0.65; font-size: 0.875rem; margin-bottom: 0.5rem; }
[data-block="team_member"] .block-team-bio { font-size: 0.875rem; line-height: 1.5; opacity: 0.85; }
[data-block="team_member"][data-layout="minimal"] .block-team-bio    { display: none; }
[data-block="team_member"][data-layout="overlay"] { position: relative; }
[data-block="team_member"][data-layout="overlay"] .block-team-body  {
  position: absolute; inset: auto 0 0 0; padding: 1rem; background: linear-gradient(transparent, rgba(0,0,0,0.7));
  color: white; text-align: left;
}
`.trim(),
  origin: 'core',
  created_at: ISO_EPOCH,
};

/**
 * `pricing_plan` — single plan in a pricing table. Designed as an item-
 * block so the pricing table is a `grid` of plans, with one optionally
 * `highlight`ed.
 */
const pricingPlan: BlockType = {
  id: 'core/pricing_plan',
  name: 'pricing_plan',
  label: 'Pricing Plan',
  icon: 'badge-dollar',
  category: 'content',
  container: false,
  item_compatible: true,
  schema: [
    { name: 'name', type: 'text', label: 'Plan name', required: true },
    { name: 'price', type: 'text', label: 'Price' },
    { name: 'period', type: 'text', label: 'Period (e.g. /month)' },
    { name: 'description', type: 'text', label: 'Tagline' },
    { name: 'features', type: 'array', label: 'Features',
      fields: [
        { name: 'text', type: 'text', label: 'Text' },
        { name: 'included', type: 'boolean', label: 'Included', default: true },
      ] },
    { name: 'cta_label', type: 'text', label: 'Button label', default: 'Get started' },
    { name: 'cta_href', type: 'url', label: 'Button link' },
    { name: 'highlight', type: 'boolean', label: 'Highlight this plan' },
    { name: 'badge', type: 'text', label: 'Badge (e.g. "Most popular")' },
  ],
  template: `<div data-block="pricing_plan" data-highlight="{{highlight}}">
  <span class="block-pricing-badge">{{badge}}</span>
  <h3 class="block-pricing-name">{{name}}</h3>
  <div class="block-pricing-price"><span class="block-pricing-amount">{{price}}</span><span class="block-pricing-period">{{period}}</span></div>
  <p class="block-pricing-description">{{description}}</p>
  <ul class="block-pricing-features" data-features="{{features}}"></ul>
  <a href="{{cta_href}}" class="block-pricing-cta">{{cta_label}}</a>
</div>`,
  styles: `
[data-block="pricing_plan"] {
  padding: 2rem 1.5rem; border-radius: 0.75rem; border: 1px solid rgba(0,0,0,0.1);
  display: flex; flex-direction: column; gap: 0.75rem; background: var(--color-bg, white);
}
[data-block="pricing_plan"][data-highlight="true"] { border-color: var(--color-primary, #111); border-width: 2px; box-shadow: 0 4px 12px rgba(0,0,0,0.05); }
[data-block="pricing_plan"] .block-pricing-badge { display: inline-block; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; background: var(--color-primary, #111); color: var(--color-primary-fg, white); padding: 0.125rem 0.5rem; border-radius: 0.25rem; align-self: flex-start; }
[data-block="pricing_plan"] .block-pricing-badge:empty { display: none; }
[data-block="pricing_plan"] .block-pricing-name { margin: 0; font-size: 1.25rem; font-weight: 600; }
[data-block="pricing_plan"] .block-pricing-price { font-size: 2rem; font-weight: 700; line-height: 1; margin: 0.25rem 0; }
[data-block="pricing_plan"] .block-pricing-period { font-size: 1rem; opacity: 0.6; font-weight: 400; }
[data-block="pricing_plan"] .block-pricing-description { margin: 0; opacity: 0.7; }
[data-block="pricing_plan"] .block-pricing-description:empty { display: none; }
[data-block="pricing_plan"] .block-pricing-features { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 0.5rem; }
[data-block="pricing_plan"] .block-pricing-cta {
  margin-top: auto; padding: 0.75rem 1.5rem; text-align: center; border-radius: 0.375rem;
  background: var(--color-primary, #111); color: var(--color-primary-fg, white);
  text-decoration: none; font-weight: 600;
}
[data-block="pricing_plan"] .block-pricing-cta[href=""] { display: none; }
`.trim(),
  origin: 'core',
  created_at: ISO_EPOCH,
};

/**
 * `post_card` — heading + excerpt + image + date + author + link. The
 * canonical item for blog/news/article listings. Field names mirror the
 * Page / Collection item shape so the repeater can auto-bind to a
 * collection source in Phase 4.
 */
const postCard: BlockType = {
  id: 'core/post_card',
  name: 'post_card',
  label: 'Post Card',
  icon: 'newspaper',
  category: 'content',
  container: false,
  item_compatible: true,
  schema: [
    { name: 'title', type: 'text', label: 'Title' },
    { name: 'excerpt', type: 'text', label: 'Excerpt' },
    { name: 'image', type: 'image', label: 'Featured image' },
    { name: 'date', type: 'date', label: 'Date' },
    { name: 'href', type: 'url', label: 'Link' },
    { name: 'author', type: 'text', label: 'Author' },
    { name: 'show_image', type: 'boolean', label: 'Show image', default: true },
    { name: 'show_excerpt', type: 'boolean', label: 'Show excerpt', default: true },
    { name: 'show_date', type: 'boolean', label: 'Show date', default: true },
    { name: 'show_author', type: 'boolean', label: 'Show author', default: false },
    { name: 'image_aspect', type: 'select', label: 'Image aspect', options: ['landscape', 'square', 'portrait'], default: 'landscape' },
  ],
  template: `<article data-block="post_card" data-aspect="{{image_aspect}}" data-img="{{show_image}}" data-exc="{{show_excerpt}}" data-date="{{show_date}}" data-author="{{show_author}}">
  <a href="{{href}}" class="block-postcard-link">
    <img class="block-postcard-image" src="{{image}}" alt="" />
    <div class="block-postcard-body">
      <h3 class="block-postcard-title">{{title}}</h3>
      <p class="block-postcard-excerpt">{{excerpt}}</p>
      <div class="block-postcard-meta">
        <time class="block-postcard-date">{{date}}</time>
        <span class="block-postcard-author">{{author}}</span>
      </div>
    </div>
  </a>
</article>`,
  styles: `
[data-block="post_card"] { display: flex; flex-direction: column; }
[data-block="post_card"] .block-postcard-link { color: inherit; text-decoration: none; display: flex; flex-direction: column; gap: 0.75rem; }
[data-block="post_card"] .block-postcard-link[href=""] { pointer-events: none; }
[data-block="post_card"] .block-postcard-image { width: 100%; object-fit: cover; border-radius: 0.5rem; background: var(--color-bg-subtle, #f3f4f6); }
[data-block="post_card"][data-aspect="landscape"] .block-postcard-image { aspect-ratio: 16/9; }
[data-block="post_card"][data-aspect="square"]    .block-postcard-image { aspect-ratio: 1; }
[data-block="post_card"][data-aspect="portrait"]  .block-postcard-image { aspect-ratio: 3/4; }
[data-block="post_card"][data-img="false"]    .block-postcard-image   { display: none; }
[data-block="post_card"] .block-postcard-title { margin: 0; font-size: 1.25rem; font-weight: 600; line-height: 1.3; }
[data-block="post_card"] .block-postcard-excerpt { margin: 0; opacity: 0.8; line-height: 1.5; }
[data-block="post_card"][data-exc="false"]     .block-postcard-excerpt { display: none; }
[data-block="post_card"] .block-postcard-meta  { font-size: 0.875rem; opacity: 0.6; display: flex; gap: 0.75rem; }
[data-block="post_card"][data-date="false"]    .block-postcard-date    { display: none; }
[data-block="post_card"][data-author="false"]  .block-postcard-author  { display: none; }
`.trim(),
  origin: 'core',
  created_at: ISO_EPOCH,
};

/**
 * `logo_item` — minimal image cell for client logos. Tiles into a row /
 * carousel of "trusted by" logos. Greyscale by default; hover removes it.
 */
const logoItem: BlockType = {
  id: 'core/logo_item',
  name: 'logo_item',
  label: 'Logo',
  icon: 'image-square',
  category: 'media',
  container: false,
  item_compatible: true,
  schema: [
    { name: 'src', type: 'image', label: 'Logo image', required: true },
    { name: 'alt', type: 'text', label: 'Alt text' },
    { name: 'link', type: 'url', label: 'Link to' },
    { name: 'grayscale', type: 'boolean', label: 'Greyscale (hover to remove)', default: true },
  ],
  template: `<div data-block="logo_item" data-grayscale="{{grayscale}}">
  <a href="{{link}}" class="block-logo-link"><img src="{{src}}" alt="{{alt}}" loading="lazy" /></a>
</div>`,
  styles: `
[data-block="logo_item"] { display: flex; align-items: center; justify-content: center; min-height: 4rem; }
[data-block="logo_item"] .block-logo-link { display: block; line-height: 0; }
[data-block="logo_item"] .block-logo-link[href=""] { pointer-events: none; }
[data-block="logo_item"] img { max-width: 100%; max-height: 3rem; width: auto; transition: filter 0.2s, opacity 0.2s; }
[data-block="logo_item"][data-grayscale="true"] img { filter: grayscale(1); opacity: 0.6; }
[data-block="logo_item"][data-grayscale="true"] img:hover { filter: none; opacity: 1; }
`.trim(),
  origin: 'core',
  created_at: ISO_EPOCH,
};

/**
 * `step_card` — numbered step in a process / how-it-works section. Item-
 * compatible so a process is a `grid` of `step_card` items.
 */
const stepCard: BlockType = {
  id: 'core/step_card',
  name: 'step_card',
  label: 'Step Card',
  icon: 'list-ordered',
  category: 'content',
  container: false,
  item_compatible: true,
  schema: [
    { name: 'number', type: 'text', label: 'Step number / label' },
    { name: 'icon', type: 'icon', label: 'Icon' },
    { name: 'title', type: 'text', label: 'Title', required: true },
    { name: 'text', type: 'richtext', label: 'Description' },
  ],
  template: `<div data-block="step_card">
  <div class="block-step-marker"><span class="block-step-number">{{number}}</span><span class="block-step-icon" data-icon="{{icon}}">{{{icon_svg}}}</span></div>
  <h3 class="block-step-title">{{title}}</h3>
  <div class="block-step-text">{{{text}}}</div>
</div>`,
  styles: `
[data-block="step_card"] { display: flex; flex-direction: column; gap: 0.5rem; }
[data-block="step_card"] .block-step-marker { display: flex; align-items: center; gap: 0.5rem; }
[data-block="step_card"] .block-step-number {
  display: inline-flex; align-items: center; justify-content: center;
  width: 2.5rem; height: 2.5rem; border-radius: 50%;
  background: var(--color-primary, #111); color: var(--color-primary-fg, white);
  font-weight: 700; font-size: 1.125rem;
}
[data-block="step_card"] .block-step-number:empty { display: none; }
[data-block="step_card"] .block-step-icon  { font-size: 1.5rem; }
[data-block="step_card"] .block-step-title { margin: 0.5rem 0 0; font-size: 1.125rem; font-weight: 600; line-height: 1.3; }
[data-block="step_card"] .block-step-text  { line-height: 1.5; opacity: 0.85; }
`.trim(),
  origin: 'core',
  created_at: ISO_EPOCH,
};

// ─── Interactive blocks ──────────────────────────────────────────────────

/**
 * `accordion` — expandable / collapsible items. The most-used pattern for
 * FAQ sections. Uses native `<details>` so it works without JS — JS just
 * enhances animation.
 */
const accordion: BlockType = {
  id: 'core/accordion',
  name: 'accordion',
  label: 'Accordion',
  icon: 'list-collapse',
  category: 'content',
  container: false,
  schema: [
    { name: 'items', type: 'array', label: 'Items',
      fields: [
        { name: 'title', type: 'text', label: 'Title', required: true },
        { name: 'content', type: 'richtext', label: 'Content' },
      ] },
    { name: 'style', type: 'select', label: 'Style', options: ['bordered', 'separated', 'flush'], default: 'bordered' },
    { name: 'default_open', type: 'select', label: 'Default open', options: ['none', 'first', 'all'], default: 'none' },
    { name: 'icon_style', type: 'select', label: 'Icon', options: ['chevron', 'plus'], default: 'chevron' },
  ],
  // Array rendering (`{{#each items}}…{{/each}}`) ships in Phase 4 with
  // the repeater work. Until then, the template references the field for
  // forward-compat and the editor surfaces the array UI.
  template: `<div data-block="accordion" data-style="{{style}}" data-icon="{{icon_style}}" data-default-open="{{default_open}}" data-items="{{items}}"></div>`,
  styles: `
[data-block="accordion"] { display: flex; flex-direction: column; }
[data-block="accordion"][data-style="bordered"]  { border: 1px solid rgba(0,0,0,0.1); border-radius: 0.5rem; }
[data-block="accordion"][data-style="separated"] { gap: 0.5rem; }
[data-block="accordion"][data-style="separated"] details { border: 1px solid rgba(0,0,0,0.1); border-radius: 0.5rem; }
[data-block="accordion"] details { padding: 1rem 1.25rem; border-bottom: 1px solid rgba(0,0,0,0.05); }
[data-block="accordion"] details:last-child { border-bottom: none; }
[data-block="accordion"] summary { cursor: pointer; font-weight: 600; list-style: none; display: flex; justify-content: space-between; align-items: center; }
[data-block="accordion"] summary::-webkit-details-marker { display: none; }
[data-block="accordion"] summary::after { content: "›"; transition: transform 0.15s; font-size: 1.25rem; }
[data-block="accordion"][data-icon="plus"] summary::after { content: "+"; }
[data-block="accordion"] details[open] summary::after { transform: rotate(90deg); }
[data-block="accordion"][data-icon="plus"] details[open] summary::after { content: "−"; transform: none; }
[data-block="accordion"] details > div { margin-top: 0.75rem; line-height: 1.6; }
`.trim(),
  origin: 'core',
  created_at: ISO_EPOCH,
};

/**
 * `tabs` — tabbed content. Uses slot-container shape so each tab's
 * content is a block tree, not just richtext. Tab labels live in the
 * `tabs` array; the slot at index i renders tab i's content.
 */
const tabs: BlockType = {
  id: 'core/tabs',
  name: 'tabs',
  label: 'Tabs',
  icon: 'panels-top-left',
  category: 'content',
  container: 'slots',
  slot_count: 6, // up to 6 tabs; extra slots empty if fewer used
  slot_labels: ['Tab 1', 'Tab 2', 'Tab 3', 'Tab 4', 'Tab 5', 'Tab 6'],
  schema: [
    { name: 'labels', type: 'array', label: 'Tab labels',
      fields: [
        { name: 'label', type: 'text', label: 'Label' },
        { name: 'icon', type: 'icon', label: 'Icon' },
      ] },
    { name: 'style', type: 'select', label: 'Style', options: ['underline', 'pills', 'boxed'], default: 'underline' },
    { name: 'align', type: 'select', label: 'Tab strip alignment', options: ['left', 'center'], default: 'left', responsive: true },
    { name: 'default_open', type: 'number', label: 'Default open tab (0-based)', default: 0 },
  ],
  template: `<div data-block="tabs" data-style="{{style}}" style="--align:{{align}}" data-default="{{default_open}}" data-labels="{{labels}}">
  <div class="block-tabs-strip" role="tablist"></div>
  <div class="block-tabs-panels">
    <div class="block-tabs-panel">{{slot:Tab 1}}</div>
    <div class="block-tabs-panel">{{slot:Tab 2}}</div>
    <div class="block-tabs-panel">{{slot:Tab 3}}</div>
    <div class="block-tabs-panel">{{slot:Tab 4}}</div>
    <div class="block-tabs-panel">{{slot:Tab 5}}</div>
    <div class="block-tabs-panel">{{slot:Tab 6}}</div>
  </div>
</div>`,
  styles: `
[data-block="tabs"] .block-tabs-strip { display: flex; gap: 0.25rem; justify-content: var(--align, flex-start); border-bottom: 1px solid rgba(0,0,0,0.1); margin-bottom: 1rem; }
[data-block="tabs"][data-style="pills"] .block-tabs-strip { border-bottom: none; gap: 0.5rem; }
[data-block="tabs"] .block-tabs-panel:not([data-active]) { display: none; }
[data-block="tabs"] .block-tabs-panel:empty { display: none; }
`.trim(),
  script: `
window.TyperollBlocks = window.TyperollBlocks || { register(){}, init(){} };
window.TyperollBlocks.register('core/tabs', (el) => {
  const labels = JSON.parse(el.dataset.labels || '[]');
  const strip  = el.querySelector('.block-tabs-strip');
  const panels = Array.from(el.querySelectorAll('.block-tabs-panel'));
  const defaultIdx = parseInt(el.dataset.default || '0', 10);
  panels.forEach((p, i) => {
    if (!p.children.length && p.textContent.trim() === '') return;
    const btn = document.createElement('button');
    btn.type = 'button'; btn.role = 'tab';
    btn.textContent = (labels[i] && labels[i].label) || ('Tab ' + (i + 1));
    btn.dataset.idx = String(i);
    btn.addEventListener('click', () => activate(i));
    strip.appendChild(btn);
  });
  function activate(idx) {
    panels.forEach((p, i) => p.toggleAttribute('data-active', i === idx));
    strip.querySelectorAll('button').forEach((b) => b.toggleAttribute('data-active', parseInt(b.dataset.idx, 10) === idx));
  }
  activate(Math.max(0, Math.min(defaultIdx, panels.length - 1)));
});
`.trim(),
  origin: 'core',
  created_at: ISO_EPOCH,
};

// ─── Media ──────────────────────────────────────────────────────────────

/**
 * `video` — single video player. Source can be YouTube, Vimeo, or a
 * direct URL. For YouTube/Vimeo we render an `<iframe>` with the embed
 * URL (lazy-loaded by default).
 */
const video: BlockType = {
  id: 'core/video',
  name: 'video',
  label: 'Video',
  icon: 'video',
  category: 'media',
  container: false,
  schema: [
    { name: 'source', type: 'select', label: 'Source', options: ['youtube', 'vimeo', 'url'], default: 'youtube' },
    { name: 'video_url', type: 'url', label: 'Video URL' },
    { name: 'poster', type: 'image', label: 'Poster image' },
    { name: 'autoplay', type: 'boolean', label: 'Autoplay (muted)' },
    { name: 'loop', type: 'boolean', label: 'Loop' },
    { name: 'muted', type: 'boolean', label: 'Muted', default: true },
    { name: 'controls', type: 'boolean', label: 'Show controls', default: true },
    { name: 'aspect_ratio', type: 'select', label: 'Aspect ratio',
      options: ['16:9', '4:3', '1:1', '9:16'], default: '16:9', responsive: true },
    { name: 'lazy_load', type: 'boolean', label: 'Lazy-load', default: true },
  ],
  // Embed URL conversion happens in the build pipeline (site-template
  // intercepts the video block and rewrites video_url to an embed-ready
  // URL). Until then this template renders an iframe with the URL as-is.
  template: `<div data-block="video" data-source="{{source}}" style="--aspect_ratio:{{aspect_ratio}}">
  <iframe src="{{video_url}}" loading="lazy" allowfullscreen></iframe>
</div>`,
  styles: `
[data-block="video"] { position: relative; width: 100%; }
[data-block="video"][style*="--aspect_ratio:16:9"] { aspect-ratio: 16/9; }
[data-block="video"][style*="--aspect_ratio:4:3"]  { aspect-ratio: 4/3; }
[data-block="video"][style*="--aspect_ratio:1:1"]  { aspect-ratio: 1/1; }
[data-block="video"][style*="--aspect_ratio:9:16"] { aspect-ratio: 9/16; max-width: 24rem; margin-inline: auto; }
[data-block="video"] iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; border-radius: 0.5rem; }
[data-block="video"] iframe[src=""] { display: none; }
`.trim(),
  origin: 'core',
  created_at: ISO_EPOCH,
};

// ─── Forms ──────────────────────────────────────────────────────────────

/**
 * `form` — contact form / lead capture. Posts to /api/forms/submit with
 * an HMAC token. Field types and schema are validated server-side before
 * the renderer signs the token; the renderer here just produces the
 * markup the visitor sees.
 *
 * The actual HMAC token + honeypot wiring happens in a render-time
 * post-processor (`forms-signing.ts` in portal) — this block declares
 * the *shape* the renderer needs to fill in.
 */
const form: BlockType = {
  id: 'core/form',
  name: 'form',
  label: 'Form',
  icon: 'inbox',
  category: 'content',
  container: false,
  schema: [
    { name: 'form_id', type: 'text', label: 'Form id (from create_form)', required: true },
    { name: 'submit_label', type: 'text', label: 'Submit button label' },
  ],
  // Rendered via RenderBlocksOptions.formSource (Forms 2.0): the caller
  // loads the Form doc, mints the submit token, prerenders static steps
  // and ships the runtime. Without a formSource this template is the
  // visible fallback so misconfiguration is obvious in preview.
  template: `<div data-block="form" data-form-id="{{form_id}}">[form: {{form_id}}]</div>`,
  styles: '',
  origin: 'core',
  created_at: ISO_EPOCH,
};


/**
 * `media_card` — image + text side by side: the "photo right of the copy"
 * layout that section+grid can't express cleanly (image needs to fill its
 * column height with object-fit). Image side is configurable; stacks with
 * the image on top below 720px. Born from the Gruppsupporter eval runs
 * (block-gap journal, runs 3-5).
 */
const mediaCard: BlockType = {
  id: 'core/media_card',
  name: 'media_card',
  label: 'Media card',
  icon: 'image-plus',
  category: 'content',
  container: false,
  schema: [
    { name: 'image', type: 'image', label: 'Image', required: true },
    { name: 'image_alt', type: 'text', label: 'Image alt text' },
    { name: 'image_side', type: 'select', label: 'Image side', options: ['right', 'left'], default: 'right' },
    { name: 'image_width', type: 'select', label: 'Image width', options: ['third', 'two-fifths', 'half'], default: 'two-fifths' },
    { name: 'heading', type: 'text', label: 'Heading' },
    { name: 'heading_level', type: 'select', label: 'Heading level', options: ['h2', 'h3'], default: 'h2' },
    { name: 'text', type: 'richtext', label: 'Text' },
    { name: 'button_label', type: 'text', label: 'Button label' },
    { name: 'button_url', type: 'url', label: 'Button link' },
    { name: 'background', type: 'color', label: 'Card background' },
    { name: 'radius', type: 'select', label: 'Corner radius', options: ['none', 'md', 'lg', 'xl'], default: 'lg' },
  ],
  template: `<div data-block="media_card" data-side="{{image_side}}" data-iw="{{image_width}}" data-radius="{{radius}}" style="--mc-bg:{{background}}">
  <div class="block-mediacard-body">
    <{{=heading_level}} class="block-mediacard-heading">{{heading}}</{{=heading_level}}>
    <div class="block-mediacard-text">{{{text}}}</div>
    <a class="block-btn block-btn-primary block-mediacard-button" href="{{button_url}}">{{button_label}}</a>
  </div>
  <div class="block-mediacard-media"><img src="{{image}}" alt="{{image_alt}}" loading="lazy" decoding="async" /></div>
</div>`,
  styles: `
[data-block="media_card"] { display: flex; align-items: stretch; gap: 2.5rem; background: var(--mc-bg, transparent); overflow: hidden; }
[data-block="media_card"][data-side="left"] { flex-direction: row-reverse; }
[data-block="media_card"][data-radius="md"] { border-radius: 0.5rem; }
[data-block="media_card"][data-radius="lg"] { border-radius: 1.25rem; }
[data-block="media_card"][data-radius="xl"] { border-radius: 1.75rem; }
[data-block="media_card"] .block-mediacard-body { flex: 1 1 0; display: flex; flex-direction: column; justify-content: center; gap: 1rem; min-width: 0; }
[data-block="media_card"] .block-mediacard-media { flex: 0 0 40%; min-width: 0; }
[data-block="media_card"][data-iw="third"] .block-mediacard-media { flex-basis: 33.333%; }
[data-block="media_card"][data-iw="half"] .block-mediacard-media { flex-basis: 50%; }
[data-block="media_card"] .block-mediacard-media img { display: block; width: 100%; height: 100%; object-fit: cover; border-radius: inherit; }
[data-block="media_card"] .block-mediacard-heading { margin: 0; }
[data-block="media_card"] .block-mediacard-text { line-height: 1.65; }
[data-block="media_card"] .block-btn { display: inline-block; padding: 0.75rem 1.75rem; border-radius: 999px; font-weight: 600; text-decoration: none; background: var(--color-primary, #111); color: var(--color-primary-fg, #fff); }
[data-block="media_card"] .block-mediacard-button { align-self: flex-start; }
[data-block="media_card"] .block-mediacard-button:empty { display: none; }
@media (max-width: 720px) {
  [data-block="media_card"], [data-block="media_card"][data-side="left"] { flex-direction: column-reverse; gap: 1.25rem; }
  [data-block="media_card"] .block-mediacard-media,
  [data-block="media_card"][data-iw="third"] .block-mediacard-media,
  [data-block="media_card"][data-iw="half"] .block-mediacard-media { flex-basis: auto; }
  [data-block="media_card"] .block-mediacard-media img { max-height: 18rem; }
}
`.trim(),
  origin: 'core',
  created_at: ISO_EPOCH,
};

/**
 * `feature_row` — full-width image + text section row: the "zig-zag"
 * feature/step list shape. Balanced 1fr/1fr columns whose halves hug the
 * CENTER GUTTER, so wide screens never open dead air between text and
 * image (the `columns` + unbalanced ratio + capped-text trap). The image
 * keeps its natural aspect (never cover-cropped — use `media_card` for a
 * boxed card with a filled image), and the row stacks to one column on
 * mobile with an explicit stack order ("image above text" is a field, not
 * a CSS fight). Alternate `image_side` row by row for the zig-zag.
 */
const featureRow: BlockType = {
  id: 'core/feature_row',
  name: 'feature_row',
  label: 'Feature row',
  icon: 'layout-list',
  category: 'content',
  container: false,
  schema: [
    { name: 'eyebrow', type: 'text', label: 'Eyebrow' },
    { name: 'heading', type: 'text', label: 'Heading' },
    { name: 'heading_level', type: 'select', label: 'Heading level', options: ['h2', 'h3'], default: 'h2' },
    { name: 'text', type: 'richtext', label: 'Text' },
    // Server-rendered button pair, same convention as hero/cta: leave a
    // label empty to hide that button.
    { name: 'primary_label', type: 'text', label: 'Primary button label' },
    { name: 'primary_url', type: 'url', label: 'Primary button link' },
    { name: 'secondary_label', type: 'text', label: 'Secondary button label' },
    { name: 'secondary_url', type: 'url', label: 'Secondary button link' },
    { name: 'image', type: 'image', label: 'Image', required: true },
    { name: 'image_alt', type: 'text', label: 'Image alt text' },
    { name: 'image_side', type: 'select', label: 'Image side', options: ['left', 'right'], default: 'left' },
    { name: 'image_max', type: 'select', label: 'Image max width', options: ['sm', 'md', 'lg', 'full'], default: 'lg' },
    { name: 'vertical_align', type: 'select', label: 'Vertical alignment', options: ['center', 'top'], default: 'center' },
    { name: 'stack_order', type: 'select', label: 'Stacked order (mobile)', options: ['image-first', 'text-first'], default: 'image-first' },
    { name: 'gap', type: 'select', label: 'Column gap', options: ['sm', 'md', 'lg', 'xl'], default: 'lg', responsive: true },
    { name: 'width', type: 'select', label: 'Width', options: ['normal', 'wide'], default: 'normal' },
    { name: 'padding_y', type: 'select', label: 'Vertical padding', options: ['none', 'sm', 'md', 'lg', 'xl'], default: 'lg', responsive: true },
    { name: 'background', type: 'color', label: 'Background color' },
  ],
  template: `<section data-block="feature_row" data-image-side="{{image_side}}" data-image-max="{{image_max}}" data-valign="{{vertical_align}}" data-stack-order="{{stack_order}}" data-width="{{width}}" style="--gap:{{gap}};--padding_y:{{padding_y}};--bg:{{background}}">
  <div class="block-frow-inner">
    <div class="block-frow-media"><img src="{{image}}" alt="{{image_alt}}" loading="lazy" decoding="async" /></div>
    <div class="block-frow-body">
      <span class="block-frow-eyebrow">{{eyebrow}}</span>
      <{{=heading_level}} class="block-frow-heading">{{heading}}</{{=heading_level}}>
      <div class="block-frow-text">{{{text}}}</div>
      <div class="block-frow-actions">
        <a class="block-btn block-btn-primary" href="{{primary_url}}">{{primary_label}}</a>
        <a class="block-btn block-btn-secondary" href="{{secondary_url}}">{{secondary_label}}</a>
      </div>
    </div>
  </div>
</section>`,
  styles: `
[data-block="feature_row"] { padding-block: var(--block-py, 4rem); padding-inline: 1rem; background: var(--bg, transparent); }
[data-block="feature_row"] .block-frow-inner {
  display: grid; grid-template-columns: 1fr 1fr; gap: var(--block-gap, 2rem);
  align-items: center; max-width: 65rem; margin-inline: auto;
}
[data-block="feature_row"][data-width="wide"] .block-frow-inner { max-width: 80rem; }
[data-block="feature_row"][data-valign="top"] .block-frow-inner { align-items: start; }
/* Both halves hug the center gutter: a capped image in the left column
   pushes right, a capped text column in the right column stays left. This
   is what keeps wide viewports from opening a void between the halves. */
[data-block="feature_row"] .block-frow-media img {
  display: block; width: 100%; max-width: var(--frow-img-max, 34rem); height: auto;
  border-radius: 0.5rem; margin-left: auto;
}
[data-block="feature_row"] .block-frow-body { max-width: 34rem; margin-right: auto; min-width: 0; }
/* image right: swap column order and mirror the gutter-hugging margins */
[data-block="feature_row"][data-image-side="right"] .block-frow-media { order: 2; }
[data-block="feature_row"][data-image-side="right"] .block-frow-body  { order: 1; }
[data-block="feature_row"][data-image-side="right"] .block-frow-media img { margin-left: 0; margin-right: auto; }
[data-block="feature_row"][data-image-side="right"] .block-frow-body { margin-right: 0; margin-left: auto; }
[data-block="feature_row"][data-image-max="sm"]   { --frow-img-max: 20rem; }
[data-block="feature_row"][data-image-max="md"]   { --frow-img-max: 28rem; }
[data-block="feature_row"][data-image-max="full"] { --frow-img-max: none; }
/* no image yet → don't render a half-empty grid */
[data-block="feature_row"] .block-frow-media:has(img[src=""]) { display: none; }
[data-block="feature_row"]:has(.block-frow-media img[src=""]) .block-frow-inner { grid-template-columns: 1fr; }
[data-block="feature_row"] .block-frow-eyebrow { display: inline-block; font-size: 0.875rem; text-transform: uppercase; letter-spacing: 0.05em; opacity: 0.7; margin-bottom: 0.5rem; }
[data-block="feature_row"] .block-frow-eyebrow:empty { display: none; }
[data-block="feature_row"] .block-frow-heading { font-size: clamp(1.5rem, 0.875rem + 2vw, 2.25rem); margin: 0 0 1rem; font-weight: 700; line-height: 1.2; }
[data-block="feature_row"] .block-frow-text { line-height: 1.65; }
[data-block="feature_row"] .block-frow-actions { display: flex; gap: 0.75rem; flex-wrap: wrap; margin-top: 1.5rem; }
[data-block="feature_row"] .block-frow-actions:not(:has(a:not(:empty))) { display: none; }
[data-block="feature_row"] .block-btn { display: inline-block; padding: 0.75rem 1.75rem; border-radius: 999px; font-weight: 600; text-decoration: none; }
[data-block="feature_row"] .block-btn-primary { background: var(--color-primary, #111); color: var(--color-primary-fg, #fff); }
[data-block="feature_row"] .block-btn-secondary { background: transparent; color: var(--color-primary, #111); box-shadow: inset 0 0 0 2px currentColor; }
[data-block="feature_row"] .block-btn:empty { display: none; }
[data-block="feature_row"][style*="--gap:sm"] { --block-gap: 1rem; }
[data-block="feature_row"][style*="--gap:md"] { --block-gap: 1.5rem; }
[data-block="feature_row"][style*="--gap:lg"] { --block-gap: 2.5rem; }
[data-block="feature_row"][style*="--gap:xl"] { --block-gap: 4rem; }
[data-block="feature_row"][style*="--padding_y:none"] { --block-py: 0; }
[data-block="feature_row"][style*="--padding_y:sm"]   { --block-py: 2rem; }
[data-block="feature_row"][style*="--padding_y:md"]   { --block-py: 3rem; }
[data-block="feature_row"][style*="--padding_y:lg"]   { --block-py: 4rem; }
[data-block="feature_row"][style*="--padding_y:xl"]   { --block-py: 6rem; }
@media (max-width: 720px) {
  /* Mobile stack. Selectors are enumerated at >= the specificity of every
     desktop order/margin rule above (see the core/columns collapse
     regression: a bare data-block rule inside a media query silently loses
     to an attribute-qualified base rule). stack_order rules come last so
     they win the order tie against the image-side rules by source order. */
  [data-block="feature_row"] .block-frow-inner { grid-template-columns: 1fr; gap: 1.5rem; }
  [data-block="feature_row"] .block-frow-media,
  [data-block="feature_row"][data-image-side="right"] .block-frow-media { order: 1; }
  [data-block="feature_row"] .block-frow-body,
  [data-block="feature_row"][data-image-side="right"] .block-frow-body { order: 2; margin-inline: 0; max-width: none; }
  [data-block="feature_row"] .block-frow-media img,
  [data-block="feature_row"][data-image-side="right"] .block-frow-media img { margin-inline: auto; }
  [data-block="feature_row"][data-stack-order="text-first"] .block-frow-media { order: 2; }
  [data-block="feature_row"][data-stack-order="text-first"] .block-frow-body  { order: 1; }
}
`.trim(),
  origin: 'core',
  created_at: ISO_EPOCH,
};

/**
 * `search` — site search over the deployed static site. The deploy
 * pipeline runs Pagefind over the built HTML whenever any page uses this
 * block (index scoped by data-pagefind-body: page content only, noindex
 * pages excluded); the block's script lazy-loads the Pagefind UI from
 * /pagefind/ at visit time. In the editor preview (no index) it degrades
 * to a friendly note.
 */
const search: BlockType = {
  id: 'core/search',
  name: 'search',
  label: 'Search',
  icon: 'search',
  category: 'content',
  container: false,
  schema: [
    { name: 'placeholder', type: 'text', label: 'Placeholder', default: 'Search…' },
  ],
  template: `<div data-block="search" data-placeholder="{{placeholder}}">
  <div class="block-search-mount"></div>
</div>`,
  styles: `
[data-block="search"] { max-width: 40rem; margin-inline: auto; padding: 1rem; }
[data-block="search"] .block-search-note { opacity: 0.6; font-size: 0.9rem; padding: 0.5rem 0; text-align: center; }
[data-block="search"] .pagefind-ui { --pagefind-ui-primary: var(--color-primary, #111); --pagefind-ui-text: var(--color-text, #111); }
`.trim(),
  script: `
window.TyperollBlocks = window.TyperollBlocks || { register(){}, init(){} };
window.TyperollBlocks.register('core/search', (el) => {
  const mount = el.querySelector('.block-search-mount');
  if (!mount || el.dataset.trSearchInit) return;
  el.dataset.trSearchInit = '1';
  const fail = () => { mount.innerHTML = '<p class="block-search-note">Search is available on the published site.</p>'; };
  const link = document.createElement('link');
  link.rel = 'stylesheet'; link.href = '/pagefind/pagefind-ui.css';
  document.head.appendChild(link);
  const s = document.createElement('script');
  s.src = '/pagefind/pagefind-ui.js';
  s.onload = () => {
    try {
      new window.PagefindUI({
        element: mount,
        showSubResults: true,
        showImages: false,
        translations: el.dataset.placeholder ? { placeholder: el.dataset.placeholder } : undefined,
      });
    } catch (e) { fail(); }
  };
  s.onerror = fail;
  document.body.appendChild(s);
});
`.trim(),
  origin: 'core',
  created_at: ISO_EPOCH,
};

/**
 * `html` — raw HTML escape hatch. For the genuinely unique thing no block
 * covers: a third-party embed, a form with a signed hidden token, a
 * hand-crafted one-off. The content renders through the same sanitizer as
 * HTML-mode pages (scripts and event handlers are stripped), so this block
 * is exactly as safe as `update_page_html` — not a script vector.
 *
 * Prefer real blocks when one fits: this block's content is opaque to the
 * editor (no per-field editing, no responsive variables, no template
 * context bindings).
 */
const htmlBlock: BlockType = {
  id: 'core/html',
  name: 'html',
  label: 'HTML',
  icon: 'code',
  category: 'content',
  container: false,
  schema: [
    // textarea (not richtext) — the portal editor shows raw markup in a
    // plain textarea instead of mangling it through a WYSIWYG.
    { name: 'html', type: 'textarea', label: 'HTML', default: '' },
  ],
  template: `<div data-block="html">{{{html}}}</div>`,
  styles: '',
  origin: 'core',
  created_at: ISO_EPOCH,
};

/**
 * The one-off scripting escape hatch.
 *
 * `core/html` covers markup no block models; this covers markup that needs
 * BEHAVIOUR. Before it existed, per-page JS had only two homes: a whole
 * custom BlockType (right for a reusable widget, heavy ceremony for a single
 * placement) or `settings.scripts_head` (site-wide, wrong scope). `<script>`
 * written into page or block markup is stripped by the renderer's sanitizer
 * no matter which credential wrote it, and that stays true — this block gives
 * code a declared home instead of loosening the sanitizer.
 *
 * `js` is listed in `script_fields`, which is what puts it under the platform
 * script gate (lib/block-script-gate.ts): the chat AI is gated on
 * `Site.ai_scripts_enabled`, API keys write it under their own authority with
 * an audit entry and a notice, portal humans are trusted. `html` is an
 * ordinary markup field and stays fully sanitized — a `<script>` tag typed in
 * there is still stripped, which is the point of separating the two.
 *
 * The code runs inside an IIFE with `el` bound to this block's root element
 * (see instanceScriptIife in render-blocks.ts). It ships in the page's block
 * bundle, outside the sanitized body, alongside per-type block scripts.
 */
const embed: BlockType = {
  id: 'core/embed',
  name: 'embed',
  label: 'Embed / Script',
  icon: 'code',
  category: 'content',
  container: false,
  schema: [
    { name: 'html', type: 'textarea', label: 'HTML', default: '' },
    {
      name: 'js',
      type: 'textarea',
      label: 'JavaScript',
      default: '',
      placeholder: "// `el` is this block's root element\nel.querySelector('button')?.addEventListener('click', () => {})",
    },
  ],
  script_fields: ['js'],
  template: `<div data-block="embed">{{{html}}}</div>`,
  styles: '',
  origin: 'core',
  created_at: ISO_EPOCH,
};

/**
 * Ordered for grouping in the editor's block picker:
 * layout → content → media → forms.
 */
export const TIER1_BLOCK_TYPES: readonly BlockType[] = [
  // Layout
  container,
  grid,
  spacer,
  divider,
  // Content
  icon,
  iconBox,
  hero,
  cta,
  testimonial,
  teamMember,
  pricingPlan,
  postCard,
  logoItem,
  stepCard,
  accordion,
  tabs,
  mediaCard,
  featureRow,
  search,
  htmlBlock,
  embed,
  // Media
  video,
  // Forms
  form,
] as const;
