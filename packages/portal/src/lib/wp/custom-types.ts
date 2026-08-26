// Map WordPress custom post types onto Typeroll collections.
//
// Strategy:
//   1. Enumerate every non-builtin post type via /wp-json/wp/v2/types.
//   2. For each type, fetch a sample item and infer the field schema from
//      what's actually present (acf{}, meta{}, native fields like content/
//      excerpt/title/date).
//   3. Create a collection on the target site with that schema.
//   4. Import items as collection items — main body via AI reconstruction,
//      custom fields mapped onto their corresponding collection fields.

import type { FieldDefinition, FieldType } from '@typeroll/shared';
import type { WPItem, WPPostType } from './client';

export interface InferredCollection {
  /** Machine name suitable for paths.collection(...) */
  name: string;
  label_singular: string;
  label_plural: string;
  icon: string;
  fields: FieldDefinition[];
  /** Source post type's REST base — what we'll call to list items. */
  source_rest_base: string;
  /** Source slug for log clarity. */
  source_slug: string;
}

const BASE_FIELDS: FieldDefinition[] = [
  { name: 'title', label: 'Title', type: 'text', required: true },
  { name: 'slug', label: 'Slug', type: 'text' },
  { name: 'body', label: 'Body (HTML)', type: 'richtext' },
  { name: 'excerpt', label: 'Excerpt', type: 'textarea' },
  { name: 'featured_image', label: 'Featured image', type: 'image' },
  { name: 'published_at', label: 'Published at', type: 'date' },
];

/** Build a collection definition for a custom post type, inferring extra fields from a sample item. */
export function inferCollection(type: WPPostType, sampleItem: WPItem | undefined): InferredCollection {
  const name = sanitizeMachineName(type.slug);
  const labelSingular = type.name || titleCase(type.slug);
  const labelPlural = pluralize(labelSingular);

  const fields: FieldDefinition[] = [...BASE_FIELDS];

  // Add fields for ACF entries on the sample.
  if (sampleItem?.acf && typeof sampleItem.acf === 'object') {
    for (const [key, value] of Object.entries(sampleItem.acf)) {
      if (BASE_FIELDS.some((f) => f.name === key)) continue;
      fields.push({
        name: sanitizeMachineName(key),
        label: titleCase(key),
        type: inferFieldType(value),
      });
    }
  }

  // Add fields for any `meta` entries on the sample (when register_post_meta
  // with show_in_rest was used). Skip _underscore-prefixed (internal).
  if (sampleItem?.meta && typeof sampleItem.meta === 'object') {
    for (const [key, value] of Object.entries(sampleItem.meta)) {
      if (key.startsWith('_')) continue;
      if (fields.some((f) => f.name === key)) continue;
      fields.push({
        name: sanitizeMachineName(key),
        label: titleCase(key),
        type: inferFieldType(value),
      });
    }
  }

  return {
    name,
    label_singular: labelSingular,
    label_plural: labelPlural,
    icon: pickIcon(name),
    fields,
    source_rest_base: type.rest_base,
    source_slug: type.slug,
  };
}

/**
 * Build the dynamic field data for one item, given the collection's schema.
 * Values from acf{} and meta{} are matched by sanitized name; anything not in
 * the schema is dropped (the API enforces this whitelist anyway).
 */
export function projectItemFields(
  item: WPItem,
  fields: FieldDefinition[],
  featuredImageUrl: string | undefined,
  bodyHtml: string
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    title: item.title?.rendered ? stripTags(item.title.rendered) : '',
    slug: item.slug,
    body: bodyHtml,
    excerpt: item.excerpt?.rendered ? stripTags(item.excerpt.rendered) : '',
    featured_image: featuredImageUrl ?? '',
    published_at: item.date,
  };

  const acf = (item.acf ?? {}) as Record<string, unknown>;
  const meta = (item.meta ?? {}) as Record<string, unknown>;

  for (const field of fields) {
    if (field.name in out) continue; // base fields already set
    const fromAcf = acf[field.name];
    if (fromAcf !== undefined && fromAcf !== null) {
      out[field.name] = coerceForField(fromAcf, field.type);
      continue;
    }
    const fromMeta = meta[field.name];
    if (fromMeta !== undefined && fromMeta !== null) {
      out[field.name] = coerceForField(fromMeta, field.type);
    }
  }

  return out;
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function inferFieldType(value: unknown): FieldType {
  if (value === null || value === undefined) return 'text';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'string') {
    if (/^https?:\/\/\S+\.(jpe?g|png|gif|webp|avif|svg)/i.test(value)) return 'image';
    if (/^https?:\/\//i.test(value)) return 'url';
    if (/^\S+@\S+\.\S+$/.test(value)) return 'email';
    if (/^\d{4}-\d{2}-\d{2}/.test(value)) return 'date';
    if (value.length > 120 || value.includes('\n')) return 'textarea';
    return 'text';
  }
  if (Array.isArray(value) || typeof value === 'object') {
    // Complex types collapse to textarea (JSON string) for now. A future
    // pass can introspect ACF field groups properly via the helper plugin.
    return 'textarea';
  }
  return 'text';
}

function coerceForField(value: unknown, type: FieldType): unknown {
  switch (type) {
    case 'text':
    case 'textarea':
    case 'richtext':
    case 'url':
    case 'email':
    case 'date':
    case 'image':
    case 'file':
    case 'color':
    case 'select':
      if (typeof value === 'string') return value;
      if (typeof value === 'object') return JSON.stringify(value);
      return String(value);
    case 'boolean':
      return Boolean(value);
    case 'number':
      return Number(value);
    default:
      return value;
  }
}

function sanitizeMachineName(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .replace(/^[0-9]/, 'n$&') || 'field'
  );
}

function titleCase(s: string): string {
  return s
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

function pluralize(s: string): string {
  if (/(s|x|z|ch|sh)$/i.test(s)) return `${s}es`;
  if (/[^aeiou]y$/i.test(s)) return `${s.slice(0, -1)}ies`;
  return `${s}s`;
}

function pickIcon(name: string): string {
  if (/blog|post|news/.test(name)) return '✍️';
  if (/team|staff|member|person|employee|author/.test(name)) return '👥';
  if (/event|calendar/.test(name)) return '📅';
  if (/product|shop|store|item/.test(name)) return '🛒';
  if (/service|offering/.test(name)) return '🛠';
  if (/project|portfolio|case/.test(name)) return '🎨';
  if (/property|listing|estate/.test(name)) return '🏠';
  if (/recipe|menu|dish|food/.test(name)) return '🍽';
  return '📋';
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, '').trim();
}
