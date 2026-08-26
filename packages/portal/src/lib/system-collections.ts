/**
 * System collections are content types the renderer + AI tools depend on by name.
 * They show up in the collections list with a "system" badge, share the same
 * tabs UI as user-defined collections, but their schema is read-only because
 * adding/removing fields would break pipelines that key off specific field names.
 *
 * Today only Pages qualifies. Forms / Submissions / Media are conceptually similar
 * but each has its own bespoke UI for legacy reasons.
 */

export interface SystemFieldDef {
  name: string;
  label: string;
  type: string;
  required?: boolean;
  group?: 'content' | 'seo' | 'routing' | 'meta';
  note?: string;
}

export interface SystemCollection {
  name: string;
  label_singular: string;
  label_plural: string;
  icon: string;
  /** Path under /app/sites/{siteId}/ — typically the collection name. */
  route: string;
  description: string;
  fields: SystemFieldDef[];
}

export const PAGES_SYSTEM_SCHEMA: SystemFieldDef[] = [
  { name: 'title', label: 'Title', type: 'text', required: true, group: 'content' },
  { name: 'slug', label: 'Slug', type: 'text', required: true, group: 'routing', note: 'Maps to /{slug} on the live site' },
  { name: 'parent', label: 'Parent page', type: 'reference', group: 'routing', note: 'Optional — for hierarchical URLs' },
  { name: 'sort_order', label: 'Sort order', type: 'number', group: 'routing' },
  { name: 'content_mode', label: 'Content mode', type: 'enum', required: true, group: 'content', note: 'html | blocks (only html renders today)' },
  { name: 'html_content', label: 'HTML body', type: 'richtext', group: 'content', note: 'Used when content_mode = html' },
  { name: 'blocks', label: 'Block tree', type: 'blocks', group: 'content', note: 'Reserved — block renderer is deferred' },
  { name: 'status', label: 'Status', type: 'enum', required: true, group: 'meta', note: 'draft | review | unlisted | published' },
  { name: 'seo_title', label: 'SEO title', type: 'text', group: 'seo' },
  { name: 'seo_description', label: 'SEO description', type: 'textarea', group: 'seo' },
  { name: 'og_image', label: 'Social image', type: 'image', group: 'seo' },
  { name: 'canonical_url', label: 'Canonical URL', type: 'url', group: 'seo' },
  { name: 'noindex', label: 'No-index', type: 'boolean', group: 'seo' },
  { name: 'json_ld', label: 'JSON-LD schema', type: 'textarea', group: 'seo' },
  { name: 'ai_generated', label: 'AI generated', type: 'boolean', group: 'meta', note: 'Set when a workflow created the page' },
  { name: 'old_wp_url', label: 'Original WP URL', type: 'url', group: 'meta', note: 'Backfilled by the migration workflow' },
];

export const PAGES_SYSTEM_COLLECTION: SystemCollection = {
  name: 'pages',
  label_singular: 'Page',
  label_plural: 'Pages',
  icon: '📄',
  route: 'pages',
  description: 'Routes to your site root. Built-in fields drive sitemap, SEO, and the renderer.',
  fields: PAGES_SYSTEM_SCHEMA,
};

export const SYSTEM_COLLECTIONS: SystemCollection[] = [PAGES_SYSTEM_COLLECTION];
