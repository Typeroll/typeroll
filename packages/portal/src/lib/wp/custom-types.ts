// Map WordPress custom post types onto Typeroll content types.
//
// Strategy:
//   1. Enumerate every non-builtin post type via /wp-json/wp/v2/types.
//   2. For each type, fetch a sample item and infer the field schema from
//      what's actually present (acf{}, meta{}, native fields like content/
//      excerpt/title/date).
//   3. Create a content type on the target site with that schema.
//   4. Import entries as Pages — main body via AI reconstruction,
//      custom fields mapped onto their corresponding content type fields.

import { PAGE_BUILTIN_FIELDS } from '@typeroll/shared';
import type { FieldDefinition, FieldType } from '@typeroll/shared';
import type { WPItem, WPPostType } from './client';
import { normalizeWordPressPlainText } from './plain-text';

export interface InferredContentType {
  /** Machine name suitable for paths.contentType(...) */
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
  { name: 'excerpt', label: 'Excerpt', type: 'textarea' },
  { name: 'featured_image', label: 'Featured image', type: 'image' },
];

/** Build a content type definition for a custom post type, inferring extra fields from a sample item. */
export function inferContentType(type: WPPostType, sampleItem: WPItem | undefined): InferredContentType {
  const name = sanitizeMachineName(type.slug);
  const labelSingular = type.name || titleCase(type.slug);
  const labelPlural = pluralize(labelSingular);

  const fields: FieldDefinition[] = [...BASE_FIELDS];

  for (const [name, value] of customValues(sampleItem)) fields.push({ name, label: titleCase(name), type: inferFieldType(value) });

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
 * Build custom Page field data from the content type's schema.
 * Values from acf{} and meta{} are matched by sanitized name; anything not in
 * the schema is dropped (the API enforces this whitelist anyway).
 */
export function projectItemFields(
  item: WPItem,
  fields: FieldDefinition[],
  featuredImageUrl: string | undefined
): Record<string, unknown> {
  const values = new Map<string, unknown>([
    ['excerpt', item.excerpt?.rendered ? normalizeWordPressPlainText(item.excerpt.rendered) : ''],
    ['featured_image', featuredImageUrl ?? ''],
    ...customValues(item),
  ]);
  const out: Record<string, unknown> = {};
  for (const field of fields) if (values.has(field.name)) out[field.name] = coerceForField(values.get(field.name), field.type);

  return out;
}

/** Preserve ACF names that overlap built-in Page fields without changing Page metadata. */
function customValues(item: WPItem | undefined): Map<string, unknown> {
  const values = new Map<string, unknown>();
  for (const [namespace, source] of [['acf', item?.acf], ['meta', item?.meta]] as const) {
    if (!source || typeof source !== 'object') continue;
    for (const [key, value] of Object.entries(source).sort(([a], [b]) => a.localeCompare(b))) {
      if (key.startsWith('_') || value == null) continue;
      let name = sanitizeMachineName(key);
      if (PAGE_BUILTIN_FIELDS.has(name) || BASE_FIELDS.some(field => field.name === name)) name = `wp_${name}`;
      if (namespace === 'meta') name = `meta_${name}`;
      if (values.has(name)) throw new Error(`WordPress field names collide after normalization: ${name}. Rename a source field before importing.`);
      values.set(name, value);
    }
  }
  return values;
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
