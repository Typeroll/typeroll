// Per-item URL + template helpers for content collections.
//
// Two pure functions used by both the static-site renderer (build time)
// and the in-portal preview renderer (request time):
//
//   resolveItemPath(template, item)   — fill route_template placeholders
//                                       with item field values + slash-
//                                       encode for URL safety.
//
//   renderItemTemplate(template, item)— fill {{field}} / {{{field}}}
//                                       placeholders in the item HTML
//                                       template. Double-brace escapes,
//                                       triple-brace leaves raw.
//
// Both treat missing fields as empty string. Substitution is intentionally
// dumb — no loops, no conditionals, no helpers. Anything fancier belongs in
// a page (HTML mode) or a future block-editor template.

import type { CollectionDef, CollectionItem } from './types.js';

const TOKEN_RE = /\{([^{}]+)\}/g;
const HTML_TRIPLE_RE = /\{\{\{([^{}]+)\}\}\}/g;
const HTML_DOUBLE_RE = /\{\{([^{}]+)\}\}/g;

function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function asString(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try { return JSON.stringify(v); } catch { return ''; }
}

/**
 * Resolve a CollectionDef.route_template against an item. Returns the
 * path (with leading slash, no trailing slash) or null when the template
 * is empty (collection opted out of per-item URLs) or a required token
 * resolves to an empty string (would yield a broken URL).
 *
 * Tokens are slash-safe — values are URI-encoded per segment so a slug
 * with spaces still resolves, but a value containing a slash splits the
 * segment (intentional: that's how date paths like `2024/01` work).
 */
export function resolveItemPath(
  template: string | undefined,
  item: CollectionItem,
): string | null {
  if (template === undefined || template === '') return null;
  let missing = false;
  const out = template.replace(TOKEN_RE, (_match, name: string) => {
    const value = asString((item as Record<string, unknown>)[name.trim()]);
    if (!value) {
      missing = true;
      return '';
    }
    return value
      .split('/')
      .map((seg) => encodeURIComponent(seg.trim()).replace(/%2F/gi, '/'))
      .join('/');
  });
  if (missing) return null;
  // Normalise: ensure leading slash, drop any trailing slash.
  const normalised = out.startsWith('/') ? out : `/${out}`;
  return normalised.replace(/\/+$/, '') || '/';
}

const DEFAULT_ITEM_TEMPLATE = `<article>
  <h1>{{title}}</h1>
  {{{body}}}
</article>`;

/**
 * Substitute {{field}} (HTML-escaped) and {{{field}}} (raw) tokens in
 * the item HTML template. Returns the merged HTML; the caller is
 * responsible for re-sanitising before injecting (defense in depth — the
 * stored template is already sanitised at save time).
 */
export function renderItemTemplate(
  template: string | undefined,
  item: CollectionItem,
): string {
  const src = template && template.trim() ? template : DEFAULT_ITEM_TEMPLATE;
  // Triple-brace first so the inner pattern doesn't get matched by the
  // double-brace pass.
  const raw = src.replace(HTML_TRIPLE_RE, (_m, name: string) =>
    asString((item as Record<string, unknown>)[name.trim()]),
  );
  return raw.replace(HTML_DOUBLE_RE, (_m, name: string) =>
    escapeHtml(asString((item as Record<string, unknown>)[name.trim()])),
  );
}

/**
 * Build the full route map for collection items in one pass. Used by the
 * static-site renderer's getStaticPaths and by the preview slug resolver.
 *
 * Filters out unpublished items + items whose route_template resolves to
 * null (missing token or opted-out collection).
 */
export interface CollectionItemRoute {
  path: string;
  collection: CollectionDef;
  item: CollectionItem;
}

export function buildCollectionRoutes(
  collections: CollectionDef[],
  itemsByCollection: Map<string, CollectionItem[]>,
): CollectionItemRoute[] {
  const out: CollectionItemRoute[] = [];
  for (const collection of collections) {
    const items = itemsByCollection.get(collection.name) ?? [];
    const template = effectiveRouteTemplate(collection);
    if (!template) continue; // explicit opt-out
    for (const item of items) {
      if (item.status !== 'published') continue;
      const path = resolveItemPath(template, item);
      if (!path) continue;
      out.push({ path, collection, item });
    }
  }
  return out;
}

/**
 * What route template the renderer actually uses for a collection.
 * Backfills the platform default `/{name}/{slug_field}` when the stored
 * value is missing — same default the v1 POST applies at create time.
 *
 * Returns "" when the collection is explicitly opted out of per-item
 * URLs (route_template was set to ""), otherwise the resolved template
 * string. Empty string is the only "no routes" signal — null and
 * undefined fall through to the default so legacy collections created
 * before the default existed start routing once items are published.
 */
export function effectiveRouteTemplate(collection: CollectionDef): string {
  if (collection.route_template === '') return '';
  if (typeof collection.route_template === 'string') return collection.route_template;
  const slugField = collection.slug_field || 'slug';
  return `/${collection.name}/{${slugField}}`;
}
