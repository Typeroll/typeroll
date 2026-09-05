// Starter `item_template_blocks` trees for the collection-create wizard.
//
// Each starter targets a common collection shape — blog, team, events,
// products, generic — and uses the template/item_* family so the same
// tree renders correctly for every item without per-item overrides.
//
// The wizard passes `template_kind: 'blog'` (etc.) when creating a
// collection; the API turns that into the matching `item_template_blocks`
// value if the caller didn't supply one explicitly. MCP / direct API
// callers can pass `template_kind` too, or skip it and either author
// the blocks themselves or fall back to the legacy `item_template_html`
// path.

import type { Block } from './types.js';

export type CollectionStarterKind =
  | 'blog'
  | 'article'
  | 'checklist'
  | 'team'
  | 'events'
  | 'products'
  | 'custom';

/**
 * Stable block ids so re-running the starter on the same collection is
 * deterministic (helpful for diff-based revision flows).
 */
function blk(id: string, type: string, data: Record<string, unknown>): Block {
  return { id: `starter_${id}`, type, data };
}

/**
 * Map shape → starter block tree. Returns undefined for shapes we don't
 * have a starter for (the API then leaves `item_template_blocks` empty
 * and falls back to the existing `item_template_html` flow).
 */
export function getCollectionStarter(kind: CollectionStarterKind | undefined): Block[] | undefined {
  switch (kind) {
    case 'blog':
      return [
        blk('image', 'template/item_image', { field: 'featured_image', width: 'wide' }),
        blk('title', 'template/item_title', { level: 'h1', size: 'auto', align: 'left' }),
        blk('date',  'template/page_date',  { field: 'published_at' }),
        blk('body',  'template/item_body',  { field: 'body', max_width: 'normal' }),
      ];

    case 'article':
      return [
        blk('breadcrumbs', 'template/page_breadcrumbs', { home_label: 'Home', aria_label: 'Breadcrumbs' }),
        blk('title', 'template/item_title', { level: 'h1', size: 'auto' }),
        blk('date', 'template/page_date', { field: 'published_at' }),
        {
          ...blk('content', 'core/columns', { ratio: '3-1', gap: 'lg', align: 'start' }),
          slots: [
            [blk('body', 'template/item_body', { field: 'body', max_width: 'normal' })],
            [blk('outline', 'core/table_of_contents', {
              title: 'On this page',
              levels: 'h2,h3',
              source_field: 'body',
            })],
          ],
        },
      ];

    case 'checklist':
      return [
        blk('breadcrumbs', 'template/page_breadcrumbs', { home_label: 'Home', aria_label: 'Breadcrumbs' }),
        blk('title', 'template/item_title', { level: 'h1', size: 'auto' }),
        {
          ...blk('pdf-condition', 'template/show_if', { condition: 'item.pdf_url' }),
          children: [blk('pdf', 'core/button', {
            label: 'Download PDF',
            href: '{{item.pdf_url}}',
            variant: 'primary',
            size: 'md',
            new_tab: false,
          })],
        },
        blk('body', 'template/item_body', { field: 'body', max_width: 'normal' }),
        blk('navigation', 'template/item_navigation', {
          previous_label: 'Previous',
          next_label: 'Next',
          aria_label: 'Checklist navigation',
          previous_url_field: 'prev_url',
          previous_title_field: 'prev_title',
          next_url_field: 'next_url',
          next_title_field: 'next_title',
        }),
      ];

    case 'team':
      return [
        blk('photo', 'template/item_image', { field: 'photo', width: 'narrow' }),
        blk('title', 'template/item_title', { level: 'h1', size: 'auto' }),
        // Use a generic prose block for the role field — there's no
        // template/item_subtitle yet and item_body assumes richtext.
        blk('role',  'core/prose', { html: '<p class="role">{{item.role}}</p>', max_width: 'narrow' }),
        blk('bio',   'template/item_body', { field: 'bio', max_width: 'narrow' }),
      ];

    case 'events':
      return [
        blk('title', 'template/item_title', { level: 'h1', size: 'auto' }),
        blk('start', 'template/page_date',  { field: 'start_at' }),
        blk('img',   'template/item_image', { field: 'image', width: 'wide' }),
        blk('body',  'template/item_body',  { field: 'description', max_width: 'normal' }),
        // CTA button — RSVP URL comes through as {{item.rsvp_url}}, but
        // the button block doesn't read context yet (it needs a literal
        // href). Leave a placeholder block the editor will warn about
        // until the user authors it.
      ];

    case 'products':
      return [
        blk('img',   'template/item_image', { field: 'image', width: 'wide' }),
        blk('title', 'template/item_title', { level: 'h1', size: 'auto' }),
        blk('body',  'template/item_body',  { field: 'description', max_width: 'normal' }),
      ];

    case 'custom':
      // For totally-custom collections we only know one field reliably
      // exists ('title'). Give the author the smallest viable scaffold —
      // they extend it from the block editor.
      return [
        blk('title', 'template/item_title', { level: 'h1', size: 'auto' }),
      ];

    default:
      return undefined;
  }
}

/**
 * Heuristically guess the shape from a collection's field list. Used as
 * a fallback when the caller didn't pass `template_kind` explicitly.
 * Looks for the canonical field names of each shape; falls back to
 * 'custom' if no clear match.
 */
export function inferStarterKind(
  fields: ReadonlyArray<{ name: string }>,
): CollectionStarterKind {
  const set = new Set(fields.map((f) => f.name.toLowerCase()));
  if (set.has('pdf_url')) return 'checklist';
  if (set.has('body') && set.has('published_at')) return 'blog';
  if (set.has('role') && set.has('photo')) return 'team';
  if (set.has('start_at') || set.has('starts_at')) return 'events';
  if (set.has('price') && (set.has('image') || set.has('photo'))) return 'products';
  return 'custom';
}
