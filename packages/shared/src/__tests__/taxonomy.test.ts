/**
 * Taxonomy routes.
 *
 * This is the one place where record count turns into ROUTE count, and route
 * count is what the build timeout actually measures. Both guards — min_items
 * and explicit combination pairs — exist to stop 500 records quietly becoming
 * several thousand thin-content pages, so both are pinned here.
 */
import { describe, it, expect } from 'vitest';
import type { CollectionDef, CollectionItem } from '../types.js';
import { DEFAULT_MIN_ITEMS, facetRoutes, facetSlug } from '../taxonomy.js';

const item = (id: string, extra: Record<string, unknown> = {}) =>
  ({ id, status: 'published', created_at: 'x', updated_at: 'x', ...extra }) as CollectionItem;

const coll = (over: Partial<CollectionDef> = {}): Pick<CollectionDef, 'facets' | 'facet_combinations'> => ({
  facets: [
    { field: 'industry', base_path: '/bransch', label_singular: 'Bransch' },
    { field: 'city', base_path: '/ort', label_singular: 'Ort' },
  ],
  ...over,
});

const ITEMS = [
  item('1', { industry: 'Rörmokare', city: 'Göteborg' }),
  item('2', { industry: 'Rörmokare', city: 'Göteborg' }),
  item('3', { industry: 'Rörmokare', city: 'Malmö' }),
  item('4', { industry: 'Elektriker', city: 'Göteborg' }),
];

describe('facetSlug', () => {
  it('folds Swedish characters rather than dropping them', () => {
    // "Rörmokare" → "rrmokare" would be a nonsense URL; the whole point of a
    // taxonomy page is that its path reads as the thing it lists.
    expect(facetSlug('Rörmokare')).toBe('rormokare');
    expect(facetSlug('Göteborg')).toBe('goteborg');
    expect(facetSlug('Malmö')).toBe('malmo');
  });

  it('collapses punctuation and trims', () => {
    expect(facetSlug('VVS & Rör')).toBe('vvs-ror');
    expect(facetSlug('  spaced  out  ')).toBe('spaced-out');
  });

  it('returns empty for a value with nothing slug-able in it', () => {
    expect(facetSlug('!!!')).toBe('');
  });
});

describe('facetRoutes', () => {
  it('generates nothing when no facets are declared', () => {
    expect(facetRoutes({ facets: [] }, ITEMS)).toEqual([]);
    expect(facetRoutes({}, ITEMS)).toEqual([]);
  });

  it('emits one route per value that clears min_items', () => {
    const routes = facetRoutes(coll(), ITEMS);
    const paths = routes.map((r) => r.path).sort();
    // Elektriker has one item and Malmö has one — both below the default
    // threshold, so neither becomes a page.
    expect(paths).toEqual(['/bransch/rormokare', '/ort/goteborg']);
  });

  it('carries the matching item ids', () => {
    const routes = facetRoutes(coll(), ITEMS);
    const industry = routes.find((r) => r.path === '/bransch/rormokare')!;
    expect(industry.item_ids.sort()).toEqual(['1', '2', '3']);
  });

  it('honours a per-facet min_items', () => {
    const routes = facetRoutes(
      coll({ facets: [{ field: 'industry', base_path: '/b', label_singular: 'B', min_items: 1 }] }),
      ITEMS,
    );
    expect(routes.map((r) => r.path).sort()).toEqual(['/b/elektriker', '/b/rormokare']);
  });

  it('defaults min_items to 2 — a one-record page is thin content', () => {
    expect(DEFAULT_MIN_ITEMS).toBe(2);
  });

  it('groups multi-valued fields, so a tag list produces one page per tag', () => {
    const routes = facetRoutes(
      { facets: [{ field: 'tags', base_path: '/tagg', label_singular: 'Tagg', min_items: 2 }] },
      [item('1', { tags: ['a', 'b'] }), item('2', { tags: ['a'] })],
    );
    expect(routes.map((r) => r.path)).toEqual(['/tagg/a']);
  });

  it('ignores items missing the facet field entirely', () => {
    const routes = facetRoutes(
      { facets: [{ field: 'industry', base_path: '/b', label_singular: 'B', min_items: 1 }] },
      [item('1', { industry: 'X' }), item('2')],
    );
    expect(routes).toHaveLength(1);
    expect(routes[0].item_ids).toEqual(['1']);
  });
});

describe('combination pages', () => {
  it('generates NONE unless the operator enumerates the pair', () => {
    // The load-bearing guard: two facets with 30 and 200 values is 6000
    // routes if this ever becomes a cartesian product by default.
    const routes = facetRoutes(coll(), ITEMS);
    expect(routes.every((r) => r.filters.length === 1)).toBe(true);
  });

  it('generates the enumerated pair, still gated on min_items', () => {
    const routes = facetRoutes(coll({ facet_combinations: [['industry', 'city']] }), ITEMS);
    const combos = routes.filter((r) => r.filters.length === 2);
    // Rörmokare×Göteborg has two items; every other pairing has one.
    expect(combos.map((r) => r.path)).toEqual(['/bransch/rormokare/goteborg']);
    expect(combos[0].item_ids.sort()).toEqual(['1', '2']);
  });

  it('ignores a pair naming a facet that does not exist', () => {
    const routes = facetRoutes(coll({ facet_combinations: [['industry', 'nope']] }), ITEMS);
    expect(routes.every((r) => r.filters.length === 1)).toBe(true);
  });

  it('keeps the first claimant on a slug collision, stably', () => {
    // "VVS & Rör" and "VVS-Rör" both slugify to vvs-ror. Sorted iteration is
    // what makes the winner the same on every build rather than a function of
    // item order — otherwise the URL would flip between deploys.
    const items = [
      item('1', { industry: 'VVS & Rör' }), item('2', { industry: 'VVS & Rör' }),
      item('3', { industry: 'VVS-Rör' }), item('4', { industry: 'VVS-Rör' }),
    ];
    const facets = { facets: [{ field: 'industry', base_path: '/b', label_singular: 'B' }] };
    const first = facetRoutes(facets, items);
    const reversed = facetRoutes(facets, [...items].reverse());
    expect(first).toHaveLength(1);
    expect(first[0].filters[0].value).toBe(reversed[0].filters[0].value);
  });
});
