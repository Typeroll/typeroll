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
      options: ['auto', 'sm', 'md', 'lg', 'xl', '2xl', '3xl'], default: 'auto', responsive: true },
    { name: 'align', type: 'select', label: 'Alignment',
      options: ['left', 'center', 'right'], default: 'left', responsive: true },
    { name: 'fallback_text', type: 'text', label: 'Fallback (when no page)', default: 'Page title' },
  ],
  template: `<div data-block="heading" data-level="{{level}}" data-size="{{size}}" style="text-align:{{align}}">
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
    { name: 'width', type: 'select', label: 'Width',
      options: ['narrow', 'normal', 'wide', 'full'], default: 'wide' },
    { name: 'aspect_ratio', type: 'select', label: 'Aspect ratio',
      options: ['auto', '16:9', '4:3', '1:1', '3:1'], default: 'auto' },
  ],
  template: `<figure data-block="image" data-w="{{width}}" style="--aspect:{{aspect_ratio}}">
  <img src="{{page.featured_image}}" alt="{{page.title}}" loading="lazy" decoding="async" />
</figure>`,
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
      options: ['published_at', 'updated_at', 'created_at'], default: 'published_at' },
    { name: 'format', type: 'text', label: 'Format', default: 'MMM D, YYYY' },
  ],
  template: `<time data-block="page-date" datetime="{{page.published_at}}">{{page.published_at}}</time>`,
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
    { name: 'separator', type: 'select', label: 'Separator', options: ['chevron', 'slash', 'arrow'], default: 'chevron' },
    { name: 'home_label', type: 'text', label: 'Home label', default: 'Home' },
  ],
  // The renderer's collection-route resolver fills in the breadcrumb
  // trail when the page is loaded. For now, the template carries a
  // placeholder; the trail is injected via context.page.breadcrumbs
  // (an array of {label, href} which a small post-processor materialises).
  template: `<nav data-block="breadcrumbs" data-sep="{{separator}}" aria-label="Breadcrumb" data-trail="{{page.breadcrumbs}}"></nav>`,
  styles: `
[data-block="breadcrumbs"] { font-size: 0.875rem; opacity: 0.7; }
[data-block="breadcrumbs"] ol { list-style: none; padding: 0; margin: 0; display: flex; gap: 0.25rem; flex-wrap: wrap; }
[data-block="breadcrumbs"] li:not(:last-child)::after { content: " › "; margin: 0 0.25rem; opacity: 0.5; }
[data-block="breadcrumbs"][data-sep="slash"] li:not(:last-child)::after { content: " / "; }
[data-block="breadcrumbs"][data-sep="arrow"] li:not(:last-child)::after { content: " → "; }
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
    { name: 'height', type: 'select', label: 'Height', options: ['sm', 'md', 'lg'], default: 'md' },
    { name: 'link_to_home', type: 'boolean', label: 'Link to home', default: true },
  ],
  template: `<a data-block="site-logo" data-size="{{height}}" href="/"><img src="{{site.logo}}" alt="{{site.name}}" /></a>`,
  styles: `
[data-block="site-logo"] { display: inline-flex; align-items: center; }
[data-block="site-logo"][data-size="sm"] img { height: 1.5rem; }
[data-block="site-logo"][data-size="md"] img { height: 2.5rem; }
[data-block="site-logo"][data-size="lg"] img { height: 4rem; }
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

// ─── Item-context blocks (for collection-item templates) ────────────────

const itemTitle: BlockType = {
  id: 'template/item_title',
  name: 'item_title',
  label: 'Item title',
  icon: 'heading',
  category: 'content',
  container: false,
  schema: [
    { name: 'level', type: 'select', label: 'Level', options: ['h1', 'h2', 'h3'], default: 'h1' },
    { name: 'size', type: 'select', label: 'Visual size', options: ['auto', 'lg', 'xl', '2xl', '3xl'], default: 'auto', responsive: true },
  ],
  template: `<div data-block="heading" data-level="{{level}}" data-size="{{size}}"><{{=level}} class="block-heading-text">{{item.title}}</{{=level}}></div>`,
  origin: 'core',
  created_at: ISO_EPOCH,
};

const itemBody: BlockType = {
  id: 'template/item_body',
  name: 'item_body',
  label: 'Item body',
  icon: 'text',
  category: 'content',
  container: false,
  schema: [
    { name: 'field', type: 'text', label: 'Field name', default: 'body' },
    { name: 'max_width', type: 'select', label: 'Max width', options: ['narrow', 'normal', 'wide'], default: 'normal' },
  ],
  template: `<div data-block="prose" data-w="{{max_width}}">{{{item.body}}}</div>`,
  origin: 'core',
  created_at: ISO_EPOCH,
};

const itemImage: BlockType = {
  id: 'template/item_image',
  name: 'item_image',
  label: 'Item image',
  icon: 'image',
  category: 'media',
  container: false,
  schema: [
    { name: 'field', type: 'text', label: 'Field name', default: 'image' },
    { name: 'width', type: 'select', label: 'Width', options: ['narrow', 'normal', 'wide', 'full'], default: 'wide' },
  ],
  template: `<figure data-block="image" data-w="{{width}}">
  <img src="{{item.image}}" alt="{{item.title}}" loading="lazy" />
</figure>`,
  origin: 'core',
  created_at: ISO_EPOCH,
};

const itemNavigation: BlockType = {
  id: 'template/item_navigation',
  name: 'item_navigation',
  label: 'Previous / next item',
  icon: 'arrow-left-right',
  category: 'content',
  container: false,
  schema: [
    { name: 'previous_label', type: 'text', label: 'Previous label', default: 'Previous' },
    { name: 'next_label', type: 'text', label: 'Next label', default: 'Next' },
  ],
  template: `<nav data-block="item_navigation" aria-label="Item navigation"><a class="item-navigation-previous" rel="prev" href="{{collection.previous.url}}"><small>{{previous_label}}</small><span>{{collection.previous.title}}</span></a><a class="item-navigation-next" rel="next" href="{{collection.next.url}}"><small>{{next_label}}</small><span>{{collection.next.title}}</span></a></nav>`,
  styles: `
[data-block="item_navigation"] { display: flex; justify-content: space-between; gap: 1rem; margin-block: 2rem; }
[data-block="item_navigation"] a { display: flex; flex-direction: column; max-width: 48%; }
[data-block="item_navigation"] a[href=""] { display: none; }
[data-block="item_navigation"] .item-navigation-next { margin-left: auto; text-align: right; }
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
  itemTitle,
  itemBody,
  itemImage,
  itemNavigation,
] as const;
