// Taxonomy (facet) pages — one static page per distinct value of a field.
//
// A directory is reached through several dimensions at once: industry,
// location, size. Category pages are the right shape for that — static,
// indexable, and what actually ranks — as opposed to a client-side faceted
// search, which ranks for nothing.
//
// ⚠️ This is the one place where 500 records quietly becomes several thousand
// ROUTES, and route count is what the 10-minute build timeout actually
// measures. Two guards, both deliberate:
//
//   min_items          — a value with one record behind it produces a
//                        thin-content page that hurts rankings more than it
//                        helps. Default 2; a facet can raise it.
//   explicit pairs     — combination pages (/industry/plumber/gothenburg/)
//                        are enumerated by the operator, never a cartesian
//                        product. Two facets with 30 and 200 values is 6000
//                        routes, nearly all of them one-record pages.

import type { CollectionDef, CollectionItem } from './types.js';

export interface CollectionFacet {
  /** Item field to group by. */
  field: string;
  /** URL prefix, e.g. "/bransch" → /bransch/rormokare/. */
  base_path: string;
  /** Singular label for headings ("Industry"). */
  label_singular: string;
  /** PageTemplate id rendered for each value. Falls back to a plain listing. */
  template?: string;
  /** Skip values with fewer than this many items. Default 2. */
  min_items?: number;
}

/** An operator-enumerated pair of facet fields to also generate. */
export type FacetCombination = [string, string];

export const DEFAULT_MIN_ITEMS = 2;

export interface FacetRoute {
  /** Site-relative path with a leading slash and no trailing slash. */
  path: string;
  /** The facets this page is scoped by — one entry, or two for a pair. */
  filters: Array<{ field: string; value: string; label_singular: string }>;
  /** Ids of the items that land on this page. */
  item_ids: string[];
  template?: string;
}

/**
 * Slugify a facet value for use in a URL. Values are human text ("VVS &
 * Rör"), so this has to be lossy — collisions are resolved by the caller
 * keeping the first value that claims a path, which is stable because the
 * value list is sorted.
 */
export function facetSlug(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[åä]/g, 'a')
    .replace(/ö/g, 'o')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function valuesOf(item: CollectionItem, field: string): string[] {
  const raw = (item as Record<string, unknown>)[field];
  // A facet field may be multi-valued (tags). Both shapes group the same way.
  if (Array.isArray(raw)) return raw.filter((v): v is string => typeof v === 'string' && v !== '');
  return typeof raw === 'string' && raw !== '' ? [raw] : [];
}

/**
 * Every taxonomy route this collection generates, from the items given.
 *
 * Published-only filtering is the caller's job — it owns that policy for
 * every other route too.
 */
export function facetRoutes(
  coll: Pick<CollectionDef, 'facets' | 'facet_combinations'>,
  items: CollectionItem[],
): FacetRoute[] {
  const facets = coll.facets ?? [];
  if (facets.length === 0) return [];

  // field → value → item ids, in a stable order so paths don't churn between
  // builds (which would invalidate the CDN for no reason).
  const buckets = new Map<string, Map<string, string[]>>();
  for (const facet of facets) {
    const perValue = new Map<string, string[]>();
    for (const item of items) {
      if (!item.id) continue;
      for (const v of valuesOf(item, facet.field)) {
        (perValue.get(v) ?? perValue.set(v, []).get(v)!).push(item.id);
      }
    }
    buckets.set(facet.field, perValue);
  }

  const routes: FacetRoute[] = [];
  const claimed = new Set<string>();

  const push = (route: FacetRoute) => {
    // First writer wins on a slug collision ("VVS & Rör" and "VVS-Rör" both
    // slugify to vvs-ror). Sorted iteration makes which one wins stable
    // across builds rather than dependent on item order.
    if (claimed.has(route.path)) return;
    claimed.add(route.path);
    routes.push(route);
  };

  for (const facet of facets) {
    const min = facet.min_items ?? DEFAULT_MIN_ITEMS;
    const perValue = buckets.get(facet.field)!;
    for (const value of [...perValue.keys()].sort()) {
      const ids = perValue.get(value)!;
      if (ids.length < min) continue;
      const slug = facetSlug(value);
      if (!slug) continue;
      push({
        path: `${facet.base_path.replace(/\/+$/, '')}/${slug}`,
        filters: [{ field: facet.field, value, label_singular: facet.label_singular }],
        item_ids: ids,
        template: facet.template,
      });
    }
  }

  // Combination pages — only the pairs the operator asked for.
  for (const [fieldA, fieldB] of coll.facet_combinations ?? []) {
    const facetA = facets.find((f) => f.field === fieldA);
    const facetB = facets.find((f) => f.field === fieldB);
    if (!facetA || !facetB) continue;
    const min = Math.max(facetA.min_items ?? DEFAULT_MIN_ITEMS, facetB.min_items ?? DEFAULT_MIN_ITEMS);
    const valuesA = [...(buckets.get(fieldA)?.keys() ?? [])].sort();
    const valuesB = [...(buckets.get(fieldB)?.keys() ?? [])].sort();
    for (const a of valuesA) {
      for (const b of valuesB) {
        const ids = items
          .filter((i) => i.id && valuesOf(i, fieldA).includes(a) && valuesOf(i, fieldB).includes(b))
          .map((i) => i.id);
        if (ids.length < min) continue;
        const slugA = facetSlug(a);
        const slugB = facetSlug(b);
        if (!slugA || !slugB) continue;
        push({
          path: `${facetA.base_path.replace(/\/+$/, '')}/${slugA}/${slugB}`,
          filters: [
            { field: fieldA, value: a, label_singular: facetA.label_singular },
            { field: fieldB, value: b, label_singular: facetB.label_singular },
          ],
          item_ids: ids,
          template: facetA.template,
        });
      }
    }
  }

  return routes;
}
