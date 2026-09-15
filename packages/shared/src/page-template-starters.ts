// Editable PageTemplate presets shared by every content type.

import type { Block } from './types.js';

export type PageTemplateStarterKind =
  | 'blog'
  | 'article'
  | 'checklist'
  | 'team'
  | 'events'
  | 'products'
  | 'custom';

/**
 * Stable block ids so re-running the starter on the same template is
 * deterministic (helpful for diff-based revision flows).
 */
function blk(id: string, type: string, data: Record<string, unknown>): Block {
  return { id: `starter_${id}`, type, data };
}

/** Native, editable starting layouts for reusable Page templates. */
export function getPageTemplateStarter(kind: PageTemplateStarterKind | undefined): Block[] | undefined {
  switch (kind) {
    case 'blog':
      return [
        blk('image', 'template/page_featured_image', { field: 'featured_image', width: 'wide' }),
        blk('title', 'template/page_title', { level: 'h1', size: 'auto', align: 'left' }),
        blk('date',  'template/page_date',  { field: 'date_published' }),
        blk('body',  'template_content_slot',  { field: 'body', max_width: 'normal' }),
      ];

    case 'article':
      return [
        blk('breadcrumbs', 'template/page_breadcrumbs', { home_label: 'Home', aria_label: 'Breadcrumbs' }),
        blk('title', 'template/page_title', { level: 'h1', size: 'auto' }),
        blk('date', 'template/page_date', { field: 'date_published' }),
        {
          ...blk('content', 'core/columns', { ratio: '3-1', gap: 'lg', align: 'start' }),
          slots: [
            [blk('body', 'template_content_slot', { field: 'body', max_width: 'normal' })],
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
        blk('title', 'template/page_title', { level: 'h1', size: 'auto' }),
        {
          ...blk('pdf-condition', 'template/show_if', { condition: 'page.pdf_url' }),
          children: [blk('pdf', 'core/button', {
            label: 'Download PDF',
            href: '{{page.pdf_url}}',
            variant: 'primary',
            size: 'md',
            new_tab: false,
          })],
        },
        blk('body', 'template_content_slot', { field: 'body', max_width: 'normal' }),
        blk('navigation', 'template/page_navigation', {
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
        blk('photo', 'template/page_featured_image', { field: 'photo', width: 'narrow' }),
        blk('title', 'template/page_title', { level: 'h1', size: 'auto' }),
        // The role is a custom Page field.
        blk('role',  'core/prose', { html: '<p class="role">{{page.role}}</p>', max_width: 'narrow' }),
        blk('bio', 'template_content_slot', {}),
      ];

    case 'events':
      return [
        blk('title', 'template/page_title', { level: 'h1', size: 'auto' }),
        blk('start', 'template/page_date',  { field: 'start_at' }),
        blk('img',   'template/page_featured_image', { field: 'image', width: 'wide' }),
        blk('body',  'template_content_slot',  {}),

      ];

    case 'products':
      return [
        blk('img',   'template/page_featured_image', { field: 'image', width: 'wide' }),
        blk('title', 'template/page_title', { level: 'h1', size: 'auto' }),
        blk('body',  'template_content_slot',  {}),
      ];

    case 'custom':
      return [
        blk('title', 'template/page_title', { level: 'h1', size: 'auto' }),
        blk('body', 'template_content_slot', {}),
      ];

    default:
      return undefined;
  }
}

/**
 * Heuristically guess the shape from a content type’s field list. Used as
 * a fallback when the caller didn't pass `template_kind` explicitly.
 * Looks for the canonical field names of each shape; falls back to
 * 'custom' if no clear match.
 */
export function inferStarterKind(
  fields: ReadonlyArray<{ name: string }>,
): PageTemplateStarterKind {
  const set = new Set(fields.map((f) => f.name.toLowerCase()));
  if (set.has('pdf_url')) return 'checklist';
  if (set.has('featured_image') || set.has('excerpt')) return 'blog';
  if (set.has('role') && set.has('photo')) return 'team';
  if (set.has('start_at') || set.has('starts_at')) return 'events';
  if (set.has('price') && (set.has('image') || set.has('photo'))) return 'products';
  return 'custom';
}
