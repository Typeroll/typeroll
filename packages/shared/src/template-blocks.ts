// `template/*` block family. These blocks read from the dynamic render
// context (page/site/item) rather than authored block-local data. Used
// inside PageTemplates to build a blog-post layout once, then have every
// blog post render with its own title / featured image / date inserted
// automatically.
//
// The blocks here are intentionally thin — they're convenience wrappers
// over the substitution syntax. A template author could equivalently
// write `<core/heading text="{{page.title}}">` directly, but the
// template/* blocks surface in the editor as named entities ("Page
// title") which is much clearer.

import type { BlockType } from './types.js';
import { pixels, typographyFields } from './presentation-fields.js';

const ISO_EPOCH = '1970-01-01T00:00:00Z';

// ─── Page-context blocks ────────────────────────────────────────────────

const pageTitle: BlockType = {
  id: 'template/page_title',
  name: 'page_title',
  label: 'Page title',
  icon: 'heading',
  category: 'layout',
  container: false,
  schema: [
    { name: 'level', type: 'select', label: 'Level (semantic)',
      options: ['h1', 'h2', 'h3', 'h4'], default: 'h1' },
    { name: 'size', type: 'select', label: 'Visual size',
      options: ['auto', 'theme', 'article', 'sm', 'md', 'lg', 'xl', '2xl', '3xl'], default: 'auto', responsive: true },
    { name: 'align', type: 'select', label: 'Alignment',
      options: ['left', 'center', 'right'], default: 'left', responsive: true },
    ...typographyFields,
    { name: 'color', type: 'color', label: 'Text color' },
    { name: 'font_weight', type: 'select', label: 'Font weight', options: ['400', '500', '600', '700', '800'] },
    { name: 'fallback_text', type: 'text', label: 'Fallback (when no page)', default: 'Page title' },
  ],
  template: `<div data-block="heading" data-level="{{level}}" data-size="{{size}}" data-font-weight="{{font_weight}}" style="text-align:{{align}};--heading-color:{{color}}">
  <{{=level}} class="block-heading-text">{{page.title}}</{{=level}}>
</div>`,
  origin: 'core',
  created_at: ISO_EPOCH,
};

const pageFeaturedImage: BlockType = {
  id: 'template/page_featured_image',
  name: 'page_featured_image',
  label: 'Page featured image',
  icon: 'image',
  category: 'media',
  container: false,
  schema: [
    { name: 'fit', type: 'select', label: 'Image fit', options: ['contain', 'cover'], default: 'contain' },
    { name: 'field', type: 'text', label: 'Image field', default: 'og_image' },
    { name: 'width', type: 'select', label: 'Width',
      options: ['narrow', 'normal', 'wide', 'full'], default: 'wide' },
    { name: 'aspect_ratio', type: 'select', label: 'Aspect ratio',
      options: ['auto', '16:9', '4:3', '1:1', '3:1'], default: 'auto' },
  ],
  template: `<figure data-block="image" data-w="{{width}}" data-fit="{{fit}}" data-aspect="{{aspect_ratio}}">
  <img src="{{selected_page_image}}" alt="{{page.title}}" loading="lazy" decoding="async" />
</figure>`,
  styles: `[data-block="image"] img { display:block; width:100%; height:auto; object-fit:contain; }
[data-block="image"][data-fit="cover"] img { object-fit:cover; }
[data-block="image"][data-aspect="16:9"] img { aspect-ratio:16/9; }
[data-block="image"][data-aspect="4:3"] img { aspect-ratio:4/3; }
[data-block="image"][data-aspect="1:1"] img { aspect-ratio:1; }
[data-block="image"][data-aspect="3:1"] img { aspect-ratio:3/1; }
`,
  origin: 'core',
  created_at: ISO_EPOCH,
};

const pageExcerpt: BlockType = {
  id: 'template/page_excerpt',
  name: 'page_excerpt',
  label: 'Page excerpt',
  icon: 'text',
  category: 'content',
  container: false,
  schema: [
    { name: 'max_width', type: 'select', label: 'Max width', options: ['narrow', 'normal', 'wide'], default: 'normal' },
  ],
  template: `<p data-block="prose" data-w="{{max_width}}">{{page.excerpt}}</p>`,
  origin: 'core',
  created_at: ISO_EPOCH,
};

const pageDate: BlockType = {
  id: 'template/page_date',
  name: 'page_date',
  label: 'Page date',
  icon: 'calendar',
  category: 'content',
  container: false,
  schema: [
    { name: 'field', type: 'select', label: 'Field',
      options: ['date_published', 'date_updated', 'created_at'], default: 'date_published' },
    { name: 'format', type: 'text', label: 'Format', default: 'MMM D, YYYY' },
  ],
  template: `<time data-block="page-date" datetime="{{selected_page_date}}">{{selected_page_date}}</time>`,
  styles: `
[data-block="page-date"] { font-size: 0.875rem; opacity: 0.7; }
`.trim(),
  origin: 'core',
  created_at: ISO_EPOCH,
};

const pageAuthor: BlockType = {
  id: 'template/page_author',
  name: 'page_author',
  label: 'Page author',
  icon: 'user',
  category: 'content',
  container: false,
  schema: [
    { name: 'show_avatar', type: 'boolean', label: 'Show avatar', default: true },
    { name: 'prefix', type: 'text', label: 'Prefix', default: 'By' },
  ],
  template: `<div data-block="page-author">
  <img src="{{page.author.avatar}}" alt="" class="block-author-avatar" />
  <span class="block-author-prefix">{{prefix}}</span>
  <span class="block-author-name">{{page.author.name}}</span>
</div>`,
  styles: `
[data-block="page-author"] { display: inline-flex; gap: 0.5rem; align-items: center; font-size: 0.875rem; }
[data-block="page-author"] .block-author-avatar { width: 2rem; height: 2rem; border-radius: 50%; object-fit: cover; }
[data-block="page-author"] .block-author-avatar[src=""] { display: none; }
[data-block="page-author"] .block-author-prefix:empty { display: none; }
`.trim(),
  origin: 'core',
  created_at: ISO_EPOCH,
};

const pageBreadcrumbs: BlockType = {
  id: 'template/page_breadcrumbs',
  name: 'page_breadcrumbs',
  label: 'Breadcrumbs',
  icon: 'chevron-right',
  category: 'content',
  container: false,
  schema: [
    pixels('padding_before_px', 'Space above (px)', 0, 160),
    pixels('padding_after_px', 'Space below (px)', 0, 160),
    { name: 'divider', type: 'boolean', label: 'Bottom divider', default: false },
    { name: 'separator', type: 'select', label: 'Separator', options: ['chevron', 'slash', 'arrow'], default: 'chevron' },
    { name: 'home_label', type: 'text', label: 'Home label', default: 'Home' },
    { name: 'aria_label', type: 'text', label: 'Accessible navigation label', default: 'Breadcrumb' },
  ],
  template: `<nav data-block="breadcrumbs" data-divider="{{divider}}" data-sep="{{separator}}" aria-label="{{aria_label}}">{{{breadcrumbs_html}}}</nav>`,
  styles: `
[data-block="breadcrumbs"] { padding-block:var(--padding_before_px, var(--breadcrumbs-before, .75rem)) var(--padding_after_px, var(--breadcrumbs-after, 2rem)); width: 100%; min-width: 0; font-size: 0.875rem; color: var(--color-text-light, currentColor); }
[data-block="breadcrumbs"][data-divider="true"] { border-bottom:1px solid color-mix(in srgb, currentColor 18%, transparent); }
[data-block="breadcrumbs"] ol { list-style: none; padding: 0; margin: 0; display: flex; align-items: baseline; gap: 0.35rem; flex-wrap: wrap; }
[data-block="breadcrumbs"] li { min-width: 0; overflow-wrap: anywhere; }
[data-block="breadcrumbs"] li:not(:last-child)::after { content: " › "; margin-inline: 0.35rem 0; opacity: 0.55; speak: never; }
[data-block="breadcrumbs"][data-sep="slash"] li:not(:last-child)::after { content: " / "; }
[data-block="breadcrumbs"][data-sep="arrow"] li:not(:last-child)::after { content: " → "; }
[data-block="breadcrumbs"] a { color: var(--color-primary, currentColor); text-underline-offset: 0.15em; }
[data-block="breadcrumbs"] a:focus-visible { outline: 2px solid var(--color-primary, currentColor); outline-offset: 3px; border-radius: 0.125rem; }
[data-block="breadcrumbs"] [aria-current="page"] { color: var(--color-text, currentColor); font-weight: 600; }
`.trim(),
  origin: 'core',
  created_at: ISO_EPOCH,
};

// ─── Site-context blocks ────────────────────────────────────────────────

const siteLogo: BlockType = {
  id: 'template/site_logo',
  name: 'site_logo',
  label: 'Site logo',
  icon: 'image-square',
  category: 'media',
  container: false,
  schema: [
    pixels('height_px', 'Height (px)', 16, 240),
    { name: 'height', type: 'select', label: 'Height', options: ['sm', 'md', 'lg'], default: 'md' },
    { name: 'link_to_home', type: 'boolean', label: 'Link to home', default: true },
  ],
  template: `<a data-block="site-logo" data-size="{{height}}" href="/"><img src="{{site.logo}}" alt="{{site.name}}" /></a>`,
  styles: `
[data-block="site-logo"] { display: inline-flex; align-items: center; }
[data-block="site-logo"][data-size="sm"] img { height: 1.5rem; }
[data-block="site-logo"][data-size="md"] img { height: 2.5rem; }
[data-block="site-logo"][data-size="lg"] img { height: 4rem; }
[data-block="site-logo"][style*="--height_px:"] img { height:var(--height_px, 40px); }
[data-block="site-logo"] img { width:auto; max-width:100%; object-fit:contain; margin:0; border-radius:0; }
[data-block="site-logo"] img[src=""] { display: none; }
`.trim(),
  origin: 'core',
  created_at: ISO_EPOCH,
};

const siteTitle: BlockType = {
  id: 'template/site_title',
  name: 'site_title',
  label: 'Site title',
  icon: 'type',
  category: 'content',
  container: false,
  schema: [
    { name: 'level', type: 'select', label: 'Level', options: ['h1', 'h2', 'h3', 'span'], default: 'h1' },
    { name: 'size', type: 'select', label: 'Visual size',
      options: ['sm', 'md', 'lg', 'xl', '2xl'], default: 'lg', responsive: true },
  ],
  template: `<div data-block="heading" data-size="{{size}}"><{{=level}} class="block-heading-text">{{site.name}}</{{=level}}></div>`,
  origin: 'core',
  created_at: ISO_EPOCH,
};

const siteTagline: BlockType = {
  id: 'template/site_tagline',
  name: 'site_tagline',
  label: 'Site tagline',
  icon: 'quote',
  category: 'content',
  container: false,
  schema: [
    { name: 'max_width', type: 'select', label: 'Max width', options: ['narrow', 'normal', 'wide'], default: 'normal' },
  ],
  template: `<p data-block="prose" data-w="{{max_width}}">{{site.tagline}}</p>`,
  origin: 'core',
  created_at: ISO_EPOCH,
};

// ─── Conditional container ──────────────────────────────────────────────

const showIf: BlockType = {
  id: 'template/show_if',
  name: 'show_if',
  label: 'Show if…',
  icon: 'eye',
  category: 'layout',
  container: 'conditional',
  schema: [
    { name: 'condition', type: 'text', label: 'Condition',
      placeholder: 'page.featured_image (truthy) | page.status === "published"' },
  ],
  origin: 'core',
  created_at: ISO_EPOCH,
};

const pageNavigation: BlockType = {
  id: 'template/page_navigation',
  name: 'page_navigation',
  label: 'Previous / next page',
  icon: 'arrow-left-right',
  category: 'content',
  container: false,
  schema: [
    { name: 'previous_label', type: 'text', label: 'Previous label', default: 'Previous' },
    { name: 'next_label', type: 'text', label: 'Next label', default: 'Next' },
    { name: 'aria_label', type: 'text', label: 'Accessible navigation label', default: 'Item navigation' },
    { name: 'previous_url_field', type: 'text', label: 'Previous URL field (optional)' },
    { name: 'previous_title_field', type: 'text', label: 'Previous title field (optional)' },
    { name: 'next_url_field', type: 'text', label: 'Next URL field (optional)' },
    { name: 'next_title_field', type: 'text', label: 'Next title field (optional)' },
  ],
  template: `<nav data-block="page_navigation" aria-label="{{aria_label}}"><a class="page-navigation-previous" data-empty="{{previous_empty}}" rel="prev" href="{{previous_url}}"><small>{{previous_label}}</small><span>{{previous_title}}</span></a><a class="page-navigation-next" data-empty="{{next_empty}}" rel="next" href="{{next_url}}"><small>{{next_label}}</small><span>{{next_title}}</span></a></nav>`,
  styles: `
[data-block="page_navigation"] { display: flex; justify-content: space-between; align-items: stretch; gap: 1rem; margin-block: 2rem; }
[data-block="page_navigation"] a { display: flex; flex: 1 1 0; min-width: 0; flex-direction: column; padding: 0.85rem 1rem; border: 1px solid color-mix(in srgb, currentColor 16%, transparent); border-radius: 0.5rem; overflow-wrap: anywhere; text-decoration: none; }
[data-block="page_navigation"] a[data-empty="true"] { display: none; }
[data-block="page_navigation"] .page-navigation-next { margin-left: auto; text-align: right; }
[data-block="page_navigation"] a:focus-visible { outline: 2px solid var(--color-primary, currentColor); outline-offset: 3px; }
@media (max-width: 540px) { [data-block="page_navigation"] { flex-direction: column; } [data-block="page_navigation"] .page-navigation-next { margin-left: 0; } }
`.trim(),
  origin: 'core',
  created_at: ISO_EPOCH,
};

export const TEMPLATE_BLOCK_TYPES: readonly BlockType[] = [
  // Page-context
  pageTitle,
  pageFeaturedImage,
  pageExcerpt,
  pageDate,
  pageAuthor,
  pageBreadcrumbs,
  // Site-context
  siteLogo,
  siteTitle,
  siteTagline,
  // Conditional
  showIf,
  // Item-context (for collection-item templates)
  pageNavigation,
] as const;
