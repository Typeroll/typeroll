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

import type { CollectionDef, CollectionItem, Page } from './types.js';
import { applyTrailingSlash, type TrailingSlashPolicy } from './url-policy.js';
import { facetRoutes } from './taxonomy.js';

const TOKEN_RE = /\{([^{}]+)\}/g;
const HTML_TRIPLE_RE = /\{\{\{([^{}]+)\}\}\}/g;
const HTML_DOUBLE_RE = /\{\{([^{}]+)\}\}/g;
// Match an innermost section. Repeating this pass supports nesting without
// turning the intentionally small collection-template language into a full
// Mustache implementation.
const HTML_SECTION_RE = /\{\{#\s*([A-Za-z0-9_.-]+)\s*\}\}((?:(?!\{\{#)[\s\S])*?)\{\{\/\s*\1\s*\}\}/g;

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

function sectionIsTruthy(value: unknown): boolean {
  if (value == null || value === false || value === 0) return false;
  if (typeof value === 'string') return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function renderSections(template: string, item: CollectionItem): string {
  let out = template;
  // A hard ceiling keeps malformed or adversarial templates bounded. Each
  // successful pass removes at least one pair, so ordinary templates finish
  // after one or two iterations.
  for (let depth = 0; depth < 32; depth += 1) {
    let changed = false;
    out = out.replace(HTML_SECTION_RE, (_match, name: string, body: string) => {
      changed = true;
      const value = (item as Record<string, unknown>)[name.trim()];
      return sectionIsTruthy(value) ? body : '';
    });
    if (!changed) break;
  }
  return out;
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
  const withSections = renderSections(src, item);
  // Triple-brace first so the inner pattern doesn't get matched by the
  // double-brace pass.
  const raw = withSections.replace(HTML_TRIPLE_RE, (_m, name: string) =>
    asString((item as Record<string, unknown>)[name.trim()]),
  );
  return raw.replace(HTML_DOUBLE_RE, (_m, name: string) =>
    escapeHtml(asString((item as Record<string, unknown>)[name.trim()])),
  );
}

/** Exact collection filter with multi-value membership semantics. */
export function collectionFieldMatches(
  item: Record<string, unknown>,
  field: string,
  expected: string,
): boolean {
  const value = item[field];
  return Array.isArray(value)
    ? value.some((entry) => String(entry) === expected)
    : String(value ?? '') === expected;
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

export interface CollectionRouteLink {
  id: string;
  title: string;
  url: string;
}

export interface CollectionRouteNavigation {
  previous?: CollectionRouteLink;
  next?: CollectionRouteLink;
}

export interface BreadcrumbItem {
  label: string;
  href: string;
  current?: boolean;
}

function pagePath(page: Pick<Page, 'slug' | 'path'>, trailingSlash: TrailingSlashPolicy): string {
  const raw = page.path || (page.slug === '' || page.slug === 'home' || page.slug === 'index' ? '/' : `/${page.slug}`);
  return applyTrailingSlash(raw, trailingSlash);
}

/** Server-side breadcrumb trail for a standalone page, excluding Home. */
export function pageBreadcrumbs(
  page: Page,
  pages: Page[],
  trailingSlash: TrailingSlashPolicy = 'ignore',
): BreadcrumbItem[] {
  const byId = new Map(pages.map((candidate) => [candidate.id, candidate]));
  const ancestors: Page[] = [];
  const seen = new Set<string>([page.id]);
  let parentId = page.parent ?? undefined;
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = byId.get(parentId);
    if (!parent) break;
    if (pagePath(parent, trailingSlash) !== '/') ancestors.unshift(parent);
    parentId = parent.parent ?? undefined;
  }
  return [
    ...ancestors.map((ancestor) => ({
      label: ancestor.title,
      href: pagePath(ancestor, trailingSlash),
    })),
    ...(pagePath(page, trailingSlash) === '/' ? [] : [{
      label: page.title,
      href: pagePath(page, trailingSlash),
      current: true,
    }]),
  ];
}

function collectionRootPath(collection: CollectionDef, trailingSlash: TrailingSlashPolicy): string {
  const template = effectiveRouteTemplate(collection);
  const prefix = template.slice(0, Math.max(0, template.indexOf('{'))).replace(/\/+$/, '') || '/';
  return applyTrailingSlash(prefix, trailingSlash);
}

/**
 * Server-side collection item trail, excluding Home. Includes the first
 * generated single-facet taxonomy route containing this item when available.
 */
export function collectionItemBreadcrumbs(
  route: CollectionItemRoute,
  siblingRoutes: CollectionItemRoute[],
  trailingSlash: TrailingSlashPolicy = 'ignore',
): BreadcrumbItem[] {
  const root = collectionRootPath(route.collection, trailingSlash);
  const title = String((route.item as Record<string, unknown>).title
    ?? (route.item as Record<string, unknown>).name
    ?? route.item.id);
  const siblings = siblingRoutes
    .filter((candidate) => candidate.collection.name === route.collection.name)
    .map((candidate) => candidate.item);
  const taxonomy = facetRoutes(route.collection, siblings)
    .find((candidate) => candidate.filters.length === 1 && candidate.item_ids.includes(route.item.id));
  return [
    ...(root === '/' ? [] : [{ label: route.collection.label_plural, href: root }]),
    ...(taxonomy ? [{
      label: taxonomy.filters[0]!.value,
      href: applyTrailingSlash(taxonomy.path, trailingSlash),
    }] : []),
    {
      label: title,
      href: applyTrailingSlash(route.path, trailingSlash),
      current: true,
    },
  ];
}

/** Resolve deterministic neighbours using the collection's configured sort. */
export function collectionRouteNavigation(
  route: CollectionItemRoute,
  routes: CollectionItemRoute[],
  trailingSlash: TrailingSlashPolicy = 'ignore',
): CollectionRouteNavigation {
  const key = route.collection.sort_field;
  const direction = route.collection.sort_dir === 'desc' ? -1 : 1;
  const siblings = routes.filter((candidate) => candidate.collection.name === route.collection.name);
  if (key) {
    siblings.sort((a, b) => {
      const av = (a.item as Record<string, unknown>)[key];
      const bv = (b.item as Record<string, unknown>)[key];
      if (av == null && bv != null) return 1;
      if (av != null && bv == null) return -1;
      const compared = String(av ?? '').localeCompare(String(bv ?? ''), undefined, { numeric: true });
      return compared === 0 ? a.path.localeCompare(b.path) : compared * direction;
    });
  } else {
    siblings.sort((a, b) => a.path.localeCompare(b.path));
  }
  const index = siblings.findIndex((candidate) => candidate.item.id === route.item.id);
  const link = (candidate: CollectionItemRoute | undefined): CollectionRouteLink | undefined => candidate ? {
    id: candidate.item.id,
    title: String((candidate.item as Record<string, unknown>).title ?? (candidate.item as Record<string, unknown>).name ?? candidate.item.id),
    url: applyTrailingSlash(candidate.path, trailingSlash),
  } : undefined;
  return { previous: link(siblings[index - 1]), next: link(siblings[index + 1]) };
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
