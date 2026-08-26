// Auto-generators for Schema.org JSON-LD on pages and collection items.
//
// Two entry points:
//
//   buildPageSchema(page, site, canonical)
//     Builds JSON-LD when Page.schema_type is set. Known types get a
//     curated shape (Service nests an Offer from page.service); anything
//     else falls back to a minimal envelope { @context, @type, name, url }
//     so unknown types still get something crawler-readable. The user can
//     extend the result via Page.json_ld which is rendered alongside.
//
//   buildCollectionItemSchema(item, collection, site, canonical)
//     Builds JSON-LD when CollectionDef.schema_type is set. Reads the
//     item's fields directly; CollectionDef.schema_field_map overrides
//     the default field-name → schema-property mapping so a podcast item
//     with an `audio_url` field becomes `contentUrl` in the JSON-LD
//     without renaming the field.
//
// Both functions return a JSON string (already serialized) or null. Same
// safe-injection convention as SEOHead's existing schema emitters — the
// caller is responsible for the `<script type="application/ld+json">`
// wrapper and for </script> escaping.

import type { CollectionDef, CollectionItem, Page, SiteSettings } from './types.js';

type SchemaObj = Record<string, unknown>;

function asString(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return '';
}

function trimToObj(obj: SchemaObj): SchemaObj | null {
  // Drop empty-string / null / undefined values so emitted JSON stays clean.
  const out: SchemaObj = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v == null) continue;
    if (typeof v === 'string' && v === '') continue;
    if (Array.isArray(v) && v.length === 0) continue;
    out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Build JSON-LD for a page based on its schema_type. Returns null when
 * schema_type is unset (callers should still emit the page's manual
 * json_ld and the auto Article/BreadcrumbList from SEOHead).
 */
export function buildPageSchema(
  page: Page,
  site: SiteSettings,
  canonical: string,
): string | null {
  const type = page.schema_type?.trim();
  if (!type) return null;
  const obj: SchemaObj = {
    '@context': 'https://schema.org',
    '@type': type,
    name: page.seo_title || page.title,
    url: canonical,
  };
  if (page.seo_description) obj.description = page.seo_description;
  if (page.og_image) obj.image = page.og_image;

  if (type === 'Service') {
    const svc = page.service ?? {};
    if (svc.description) obj.description = svc.description;
    if (site.organization?.name || site.site_name) {
      obj.provider = {
        '@type': 'Organization',
        name: site.organization?.name || site.site_name,
      };
    }
    const hasPrice = svc.price !== undefined && svc.price !== '' && svc.price !== null;
    if (hasPrice) {
      const offer: SchemaObj = {
        '@type': 'Offer',
        price: typeof svc.price === 'number' ? svc.price : asString(svc.price),
      };
      if (svc.price_currency) offer.priceCurrency = svc.price_currency;
      if (svc.url) offer.url = svc.url;
      obj.offers = offer;
    }
    if (svc.duration) obj.termsOfService = svc.duration;
  }

  const trimmed = trimToObj(obj);
  return trimmed ? JSON.stringify(trimmed) : null;
}

/**
 * Default field-name → schema-property mapping for common collection types.
 * Falls back to identity if the type isn't known and the user didn't
 * provide a schema_field_map.
 */
const DEFAULT_FIELD_MAPS: Record<string, Record<string, string>> = {
  BlogPosting: {
    title: 'headline',
    body: 'articleBody',
    excerpt: 'description',
    image: 'image',
    featured_image: 'image',
    author: 'author',
    date_published: 'datePublished',
    date_updated: 'dateModified',
  },
  Article: {
    title: 'headline',
    body: 'articleBody',
    excerpt: 'description',
    image: 'image',
    author: 'author',
    date_published: 'datePublished',
    date_updated: 'dateModified',
  },
  PodcastEpisode: {
    title: 'name',
    description: 'description',
    show_notes: 'description',
    audio_url: 'contentUrl',
    duration: 'timeRequired',
    episode_number: 'episodeNumber',
    season_number: 'seasonNumber',
    date_published: 'datePublished',
    image: 'image',
  },
  Product: {
    title: 'name',
    description: 'description',
    image: 'image',
    sku: 'sku',
    brand: 'brand',
  },
  Event: {
    title: 'name',
    description: 'description',
    image: 'image',
    start_date: 'startDate',
    end_date: 'endDate',
    location: 'location',
  },
  Recipe: {
    title: 'name',
    description: 'description',
    image: 'image',
    prep_time: 'prepTime',
    cook_time: 'cookTime',
    total_time: 'totalTime',
    ingredients: 'recipeIngredient',
    instructions: 'recipeInstructions',
  },
  Course: {
    title: 'name',
    description: 'description',
    image: 'image',
    provider: 'provider',
  },
};

/**
 * Resolve which schema property an item field maps to. Priority:
 *   1. CollectionDef.schema_field_map (user override)
 *   2. DEFAULT_FIELD_MAPS[schemaType] (built-in for known types)
 *   3. Identity (field name used verbatim)
 */
function resolveProperty(
  fieldName: string,
  schemaType: string,
  userMap?: Record<string, string>,
): string {
  if (userMap && userMap[fieldName]) return userMap[fieldName];
  const builtin = DEFAULT_FIELD_MAPS[schemaType];
  if (builtin && builtin[fieldName]) return builtin[fieldName];
  return fieldName;
}

/**
 * Build JSON-LD for a single collection item route. Returns null when the
 * collection has no schema_type configured.
 *
 * The item's fields are walked; recognised primitives (string / number /
 * boolean) become top-level properties on the schema object. Object / array
 * values are passed through verbatim — gives users control to author
 * Schema.org sub-objects in the item editor when needed.
 *
 * Always emits `url` (the canonical route) and `@type` from the collection
 * config. Author/publisher derive from site.organization when known.
 */
export function buildCollectionItemSchema(
  item: CollectionItem,
  collection: CollectionDef,
  site: SiteSettings,
  canonical: string,
): string | null {
  const schemaType = collection.schema_type?.trim();
  if (!schemaType) return null;

  const obj: SchemaObj = {
    '@context': 'https://schema.org',
    '@type': schemaType,
    url: canonical,
  };

  const userMap = collection.schema_field_map;
  const data = item as Record<string, unknown>;

  for (const [field, value] of Object.entries(data)) {
    if (field === 'id' || field === 'status' || field === 'created_at' || field === 'updated_at') {
      continue;
    }
    if (value == null || value === '') continue;
    const prop = resolveProperty(field, schemaType, userMap);
    // Author / publisher / provider get the Person/Organization envelope
    // automatically when the value is a plain string — Schema.org requires
    // a typed sub-object here, and "name only" is the common authoring case.
    if (typeof value === 'string') {
      if (prop === 'author') {
        obj[prop] = { '@type': 'Person', name: value };
        continue;
      }
      if (prop === 'publisher' || prop === 'provider') {
        obj[prop] = { '@type': 'Organization', name: value };
        continue;
      }
    }
    obj[prop] = value;
  }

  // updated_at / created_at fall back to schema-standard dateModified /
  // datePublished when the item didn't carry explicit fields.
  if (!obj.dateModified && item.updated_at) obj.dateModified = item.updated_at;
  if (!obj.datePublished && item.created_at) obj.datePublished = item.created_at;

  if (!obj.publisher && site.organization?.name) {
    obj.publisher = {
      '@type': 'Organization',
      name: site.organization.name,
      ...(site.organization.logo
        ? { logo: { '@type': 'ImageObject', url: site.organization.logo } }
        : {}),
    };
  }

  const trimmed = trimToObj(obj);
  return trimmed ? JSON.stringify(trimmed) : null;
}
