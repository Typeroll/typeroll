// `core/repeater` and its alias blocks. Together they replace the
// "specialised widget per layout × per item-shape" model with a single
// primitive that takes a source (static items or a collection query), an
// item block type, and a layout. Gallery / logo cloud / testimonial
// carousel / pricing table / collection list / feature grid all collapse
// into thin alias blocks that expand to `core/repeater` at render time
// with curated defaults — see `BlockType.expand_to`.

import type { BlockType } from './types.js';

const ISO_EPOCH = '1970-01-01T00:00:00Z';

// ─── The primitive ──────────────────────────────────────────────────────

/**
 * `core/repeater` — generic looping container. Power users (and the AI
 * when prompted explicitly) build novel patterns with this directly.
 * Everyday composition uses the alias blocks below.
 */
const repeater: BlockType = {
  id: 'core/repeater',
  name: 'repeater',
  label: 'Repeater',
  icon: 'list-tree',
  category: 'layout',
  container: 'repeater',
  schema: [
    // SOURCE
    { name: 'source_type', type: 'select', label: 'Source',
      options: ['static', 'collection', 'children_blocks'], default: 'static' },
    { name: 'items', type: 'array', label: 'Items',
      // The item-shape is dynamic — the editor mirrors the item_block's
      // schema for each row in the array. The renderer just walks the
      // array of objects without caring about the shape.
      fields: [] },
    { name: 'collection', type: 'collection_ref', label: 'Collection' },
    { name: 'limit', type: 'number', label: 'Max items', default: 12 },
    // Archive pagination (collection sources only): items per page. The
    // build generates /page/2/, /page/3/… routes for the page holding this
    // listing and the repeater renders the slice + a pager. Supersedes
    // `limit`. One paginated listing per page (the first found drives the
    // routes).
    { name: 'paginate', type: 'number', label: 'Items per page (archive)', min: 1 },
    { name: 'sort_by', type: 'text', label: 'Sort by field', default: 'published_at' },
    { name: 'sort_order', type: 'select', label: 'Sort order', options: ['asc', 'desc'], default: 'desc' },
    { name: 'filter_field', type: 'text', label: 'Filter on field' },
    { name: 'filter_value', type: 'text', label: 'Filter value' },
    { name: 'pinned_ids', type: 'list_simple', label: 'Pinned item ids' },
    { name: 'group_by', type: 'text', label: 'Group by field' },
    { name: 'group_sort_order', type: 'select', label: 'Group order', options: ['asc', 'desc'], default: 'asc' },
    { name: 'group_heading_level', type: 'select', label: 'Group heading level', options: ['h2', 'h3', 'h4'], default: 'h2' },
    { name: 'ungrouped_label', type: 'text', label: 'Ungrouped label', default: 'Other' },

    // ITEM BLOCK
    { name: 'item_block', type: 'block_type_ref', label: 'Item block', required: true },
    { name: 'item_overrides', type: 'object', label: 'Item overrides' },

    // LAYOUT
    { name: 'layout', type: 'select', label: 'Layout',
      options: ['grid', 'masonry', 'list', 'carousel', 'justified', 'stack'], default: 'grid' },
    { name: 'cols', type: 'number', label: 'Columns', default: 3, min: 1, max: 6, responsive: true },
    { name: 'gap', type: 'select', label: 'Gap', options: ['none', 'xs', 'sm', 'md', 'lg', 'xl'], default: 'md', responsive: true },
    { name: 'align', type: 'select', label: 'Item alignment', options: ['start', 'center', 'end', 'stretch'], default: 'stretch', responsive: true },

    // CAROUSEL OPTIONS
    { name: 'autoplay', type: 'boolean', label: 'Autoplay (carousel)' },
    { name: 'show_arrows', type: 'boolean', label: 'Show arrows (carousel)', default: true },
    { name: 'show_dots', type: 'boolean', label: 'Show dots (carousel)', default: true },

    // CHROME
    { name: 'show_pagination', type: 'boolean', label: 'Show pagination' },
    { name: 'empty_state', type: 'richtext', label: 'Empty-state message' },
  ],
  // The renderer special-cases `container: 'repeater'` and wraps the
  // items in a div with data-block="repeater". The template here is a
  // fallback — not normally used — surfaced if someone wires the block
  // without a proper repeater handler.
  template: `<div data-block="repeater" data-layout="{{layout}}"><!-- repeater items render here --></div>`,
  styles: `
[data-block="repeater"] { --rep-gap: 1rem; }
[data-block="repeater"][style*="--gap:none"] { --rep-gap: 0; }
[data-block="repeater"][style*="--gap:xs"]   { --rep-gap: 0.25rem; }
[data-block="repeater"][style*="--gap:sm"]   { --rep-gap: 0.5rem; }
[data-block="repeater"][style*="--gap:md"]   { --rep-gap: 1rem; }
[data-block="repeater"][style*="--gap:lg"]   { --rep-gap: 2rem; }
[data-block="repeater"][style*="--gap:xl"]   { --rep-gap: 3rem; }

[data-block="repeater"][data-layout="grid"] {
  /* Read --cols directly so the responsive @media compiler's per-breakpoint
     --cols overrides take effect. (The old [style*="--cols:N"] overrides were
     redundant with this rule AND shadowed the responsive values via higher
     specificity — an attribute-substring match can't see a computed var.) */
  display: grid; grid-template-columns: repeat(var(--cols, 3), minmax(0, 1fr));
  gap: var(--rep-gap); align-items: var(--align, stretch);
}

[data-block="repeater"][data-layout="justified"] {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
  gap: var(--rep-gap); align-items: var(--align, stretch);
}

[data-block="repeater"][data-layout="list"] {
  display: flex; flex-direction: column; gap: var(--rep-gap);
}

[data-block="repeater"][data-layout="stack"] {
  display: flex; flex-wrap: wrap; gap: var(--rep-gap); align-items: var(--align, center);
}

[data-block="repeater"][data-layout="masonry"] {
  column-count: var(--cols, 3); column-gap: var(--rep-gap);
}
[data-block="repeater"][data-layout="masonry"] > * { break-inside: avoid; margin-bottom: var(--rep-gap); }

[data-block="repeater"][data-layout="carousel"] {
  display: flex; overflow-x: auto; scroll-snap-type: x mandatory; gap: var(--rep-gap);
  scrollbar-width: thin;
}
[data-block="repeater"][data-layout="carousel"] > * { flex: 0 0 calc((100% - (var(--cols, 3) - 1) * var(--rep-gap)) / var(--cols, 3)); scroll-snap-align: start; }

.tr-repeater-group + .tr-repeater-group { margin-top: 2rem; }
.tr-repeater-group-title { margin: 0 0 0.75rem; }

@media (max-width: 639px) {
  /* Default to single column on mobile when cols isn't responsively set */
  [data-block="repeater"][data-layout="grid"]:not([data-bid]) { grid-template-columns: 1fr; }
  [data-block="repeater"][data-layout="masonry"]:not([data-bid]) { column-count: 1; }
}
`.trim(),
  origin: 'core',
  created_at: ISO_EPOCH,
};

// ─── Alias blocks ───────────────────────────────────────────────────────
//
// Each alias has a curated schema (only the fields a user actually wants
// to set in editor) plus an `expand_to` that fills in repeater defaults.
// The page tree stays readable (`type: 'core/gallery'`); the renderer
// resolves the alias to the repeater at render time.
//
// IMPORTANT: aliases are stored with their own type id (`core/gallery`)
// but the renderer ignores their schema and template — it follows
// `expand_to.target` and merges defaults. We keep a token template here
// so older renderers (without expand_to support) don't break with empty
// HTML — they just render whatever the alias template says.

/**
 * `core/gallery` — image grid. The most common alias.
 */
const gallery: BlockType = {
  id: 'core/gallery',
  name: 'gallery',
  label: 'Gallery',
  icon: 'images',
  category: 'media',
  container: 'repeater',
  expand_to: {
    target: 'core/repeater',
    defaults: {
      source_type: 'static',
      item_block: 'core/image',
      layout: 'grid',
      cols: 3,
      gap: 'md',
    },
  },
  // The editor only surfaces these two fields. The rest of the repeater's
  // schema is hidden behind the alias.
  schema: [
    { name: 'items', type: 'array', label: 'Images',
      fields: [
        { name: 'src', type: 'image', label: 'Image' },
        { name: 'alt', type: 'text', label: 'Alt text' },
        { name: 'caption', type: 'text', label: 'Caption' },
        { name: 'link', type: 'url', label: 'Link' },
      ] },
    { name: 'cols', type: 'number', label: 'Columns', default: 3, min: 1, max: 6, responsive: true },
    { name: 'layout', type: 'select', label: 'Layout', options: ['grid', 'masonry', 'justified'], default: 'grid' },
    { name: 'gap', type: 'select', label: 'Gap', options: ['none', 'xs', 'sm', 'md', 'lg', 'xl'], default: 'md', responsive: true },
  ],
  origin: 'core',
  created_at: ISO_EPOCH,
};

/**
 * `core/logo_cloud` — "trusted by" logo row / grid.
 */
const logoCloud: BlockType = {
  id: 'core/logo_cloud',
  name: 'logo_cloud',
  label: 'Logo Cloud',
  icon: 'badges',
  category: 'content',
  container: 'repeater',
  expand_to: {
    target: 'core/repeater',
    defaults: {
      source_type: 'static',
      item_block: 'core/logo_item',
      layout: 'grid',
      cols: 6,
      gap: 'lg',
      align: 'center',
    },
  },
  schema: [
    { name: 'items', type: 'array', label: 'Logos',
      fields: [
        { name: 'src', type: 'image', label: 'Logo' },
        { name: 'alt', type: 'text', label: 'Alt text' },
        { name: 'link', type: 'url', label: 'Link' },
        { name: 'grayscale', type: 'boolean', label: 'Greyscale', default: true },
      ] },
    { name: 'cols', type: 'number', label: 'Columns', default: 6, min: 2, max: 8, responsive: true },
  ],
  origin: 'core',
  created_at: ISO_EPOCH,
};

/**
 * `core/testimonials` — testimonial carousel (or grid).
 */
const testimonials: BlockType = {
  id: 'core/testimonials',
  name: 'testimonials',
  label: 'Testimonials',
  icon: 'message-circle',
  category: 'content',
  container: 'repeater',
  expand_to: {
    target: 'core/repeater',
    defaults: {
      source_type: 'static',
      item_block: 'core/testimonial',
      layout: 'carousel',
      cols: 3,
      gap: 'lg',
      show_dots: true,
      show_arrows: true,
    },
  },
  schema: [
    { name: 'items', type: 'array', label: 'Testimonials',
      fields: [
        { name: 'quote', type: 'richtext', label: 'Quote' },
        { name: 'name', type: 'text', label: 'Name' },
        { name: 'role', type: 'text', label: 'Role' },
        { name: 'company', type: 'text', label: 'Company' },
        { name: 'avatar', type: 'image', label: 'Avatar' },
        { name: 'rating', type: 'number', label: 'Rating', min: 0, max: 5 },
      ] },
    { name: 'layout', type: 'select', label: 'Layout', options: ['carousel', 'grid'], default: 'carousel' },
    { name: 'cols', type: 'number', label: 'Columns', default: 3, min: 1, max: 4, responsive: true },
  ],
  origin: 'core',
  created_at: ISO_EPOCH,
};

/**
 * `core/feature_grid` — icon_box grid for "Why us" / features sections.
 */
const featureGrid: BlockType = {
  id: 'core/feature_grid',
  name: 'feature_grid',
  label: 'Feature Grid',
  icon: 'sparkles',
  category: 'content',
  container: 'repeater',
  expand_to: {
    target: 'core/repeater',
    defaults: {
      source_type: 'static',
      item_block: 'core/icon_box',
      layout: 'grid',
      cols: 3,
      gap: 'lg',
    },
  },
  schema: [
    { name: 'items', type: 'array', label: 'Features',
      fields: [
        { name: 'icon', type: 'icon', label: 'Icon' },
        { name: 'heading', type: 'text', label: 'Heading' },
        { name: 'text', type: 'richtext', label: 'Body' },
        { name: 'link', type: 'url', label: 'Link' },
      ] },
    { name: 'cols', type: 'number', label: 'Columns', default: 3, min: 1, max: 4, responsive: true },
  ],
  origin: 'core',
  created_at: ISO_EPOCH,
};

/**
 * `core/pricing_table` — grid of pricing_plan items.
 */
const pricingTable: BlockType = {
  id: 'core/pricing_table',
  name: 'pricing_table',
  label: 'Pricing Table',
  icon: 'table',
  category: 'content',
  container: 'repeater',
  expand_to: {
    target: 'core/repeater',
    defaults: {
      source_type: 'static',
      item_block: 'core/pricing_plan',
      layout: 'grid',
      cols: 3,
      gap: 'md',
      align: 'stretch',
    },
  },
  schema: [
    { name: 'items', type: 'array', label: 'Plans',
      fields: [
        { name: 'name', type: 'text', label: 'Name' },
        { name: 'price', type: 'text', label: 'Price' },
        { name: 'period', type: 'text', label: 'Period' },
        { name: 'description', type: 'text', label: 'Tagline' },
        { name: 'features', type: 'array', label: 'Features',
          fields: [
            { name: 'text', type: 'text', label: 'Text' },
            { name: 'included', type: 'boolean', label: 'Included', default: true },
          ] },
        { name: 'cta_label', type: 'text', label: 'Button label' },
        { name: 'cta_href', type: 'url', label: 'Button link' },
        { name: 'highlight', type: 'boolean', label: 'Highlight' },
        { name: 'badge', type: 'text', label: 'Badge' },
      ] },
    { name: 'cols', type: 'number', label: 'Columns', default: 3, min: 2, max: 4, responsive: true },
  ],
  origin: 'core',
  created_at: ISO_EPOCH,
};

/**
 * `core/team_grid` — grid of team_member items.
 */
const teamGrid: BlockType = {
  id: 'core/team_grid',
  name: 'team_grid',
  label: 'Team',
  icon: 'users',
  category: 'content',
  container: 'repeater',
  expand_to: {
    target: 'core/repeater',
    defaults: {
      source_type: 'static',
      item_block: 'core/team_member',
      layout: 'grid',
      cols: 4,
      gap: 'lg',
    },
  },
  schema: [
    { name: 'items', type: 'array', label: 'Team members',
      fields: [
        { name: 'name', type: 'text', label: 'Name' },
        { name: 'role', type: 'text', label: 'Role' },
        { name: 'bio', type: 'richtext', label: 'Bio' },
        { name: 'photo', type: 'image', label: 'Photo' },
        { name: 'link', type: 'url', label: 'Profile link' },
      ] },
    { name: 'cols', type: 'number', label: 'Columns', default: 4, min: 2, max: 6, responsive: true },
  ],
  origin: 'core',
  created_at: ISO_EPOCH,
};

/**
 * `core/collection_list` — repeater with a collection source. Replaces
 * the AI hand-rolled listing HTML pattern with a structured block. The
 * site renderer's collection-source resolver fills in items at build
 * time.
 */
const collectionList: BlockType = {
  id: 'core/collection_list',
  name: 'collection_list',
  label: 'Collection List',
  icon: 'list',
  category: 'content',
  container: 'repeater',
  expand_to: {
    target: 'core/repeater',
    defaults: {
      source_type: 'collection',
      item_block: 'core/post_card',
      layout: 'grid',
      cols: 3,
      gap: 'md',
    },
  },
  schema: [
    { name: 'collection', type: 'collection_ref', label: 'Collection', required: true },
    { name: 'limit', type: 'number', label: 'Max items', default: 12 },
    { name: 'sort_by', type: 'text', label: 'Sort by field', default: 'published_at' },
    { name: 'sort_order', type: 'select', label: 'Sort order', options: ['asc', 'desc'], default: 'desc' },
    { name: 'filter_field', type: 'text', label: 'Filter field' },
    { name: 'filter_value', type: 'text', label: 'Filter value' },
    { name: 'item_block', type: 'block_type_ref', label: 'Item block', default: 'core/post_card' },
    { name: 'item_overrides', type: 'object', label: 'Item field mapping', fields: [
      { name: 'title_field', type: 'text', label: 'Title field', default: 'title' },
      { name: 'excerpt_field', type: 'text', label: 'Excerpt field', default: 'excerpt' },
      { name: 'image_field', type: 'text', label: 'Image field', default: 'image' },
      { name: 'image_alt_field', type: 'text', label: 'Image alt field', default: 'image_alt' },
      { name: 'date_field', type: 'text', label: 'Date field', default: 'published_at' },
      { name: 'author_field', type: 'text', label: 'Author field', default: 'author' },
      { name: 'href_field', type: 'text', label: 'Link field', default: 'url' },
      { name: 'heading_level', type: 'select', label: 'Heading level', options: ['h2', 'h3', 'h4'], default: 'h2' },
      { name: 'download_url_field', type: 'text', label: 'Download URL field' },
      { name: 'download_label', type: 'text', label: 'Download label', default: 'Download PDF' },
    ] },
    { name: 'layout', type: 'select', label: 'Layout', options: ['grid', 'list', 'carousel', 'masonry'], default: 'grid' },
    { name: 'cols', type: 'number', label: 'Columns', default: 3, min: 1, max: 4, responsive: true },
    { name: 'gap', type: 'select', label: 'Gap', options: ['sm', 'md', 'lg'], default: 'md' },
    { name: 'empty_state', type: 'richtext', label: 'Empty-state message' },
  ],
  origin: 'core',
  created_at: ISO_EPOCH,
};

/**
 * Ordered for the editor's block picker.
 */
export const REPEATER_BLOCK_TYPES: readonly BlockType[] = [
  repeater,
  gallery,
  logoCloud,
  testimonials,
  featureGrid,
  pricingTable,
  teamGrid,
  collectionList,
] as const;
