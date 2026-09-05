import { describe, it, expect } from 'vitest';
import {
  resolveItemPath,
  renderItemTemplate,
  buildCollectionRoutes,
  collectionFieldMatches,
  collectionRouteNavigation,
  collectionItemBreadcrumbs,
  pageBreadcrumbs,
} from '../collection-routes.js';
import type { CollectionDef, CollectionItem } from '../types.js';

function item(fields: Record<string, unknown> = {}): CollectionItem {
  return {
    id: 'i1',
    status: 'published',
    created_at: '2026-01-01',
    updated_at: '2026-01-01',
    ...fields,
  };
}

describe('resolveItemPath', () => {
  it('substitutes {slug} into the template', () => {
    expect(resolveItemPath('/restaurants/{slug}', item({ slug: 'joes-pizza' })))
      .toBe('/restaurants/joes-pizza');
  });

  it('preserves slashes inside multi-segment values (date paths)', () => {
    expect(resolveItemPath('/blog/{date}/{slug}', item({ date: '2024/01', slug: 'foo' })))
      .toBe('/blog/2024/01/foo');
  });

  it('URL-encodes per segment without escaping the separator', () => {
    expect(resolveItemPath('/items/{slug}', item({ slug: 'hello world' })))
      .toBe('/items/hello%20world');
  });

  it('returns null when the template is empty (opted out)', () => {
    expect(resolveItemPath('', item({ slug: 'x' }))).toBeNull();
    expect(resolveItemPath(undefined, item({ slug: 'x' }))).toBeNull();
  });

  it('returns null when a token resolves to empty', () => {
    expect(resolveItemPath('/blog/{slug}', item({ title: 'no slug' }))).toBeNull();
  });

  it('adds a leading slash if missing, strips trailing', () => {
    expect(resolveItemPath('items/{slug}/', item({ slug: 'x' }))).toBe('/items/x');
  });
});

describe('renderItemTemplate', () => {
  it('escapes {{field}} substitutions', () => {
    const html = renderItemTemplate(
      '<p>{{title}}</p>',
      item({ title: 'A <b>bold</b> claim' }),
    );
    expect(html).toBe('<p>A &lt;b&gt;bold&lt;/b&gt; claim</p>');
  });

  it('leaves {{{field}}} raw (for richtext bodies)', () => {
    const html = renderItemTemplate(
      '<article>{{{body}}}</article>',
      item({ body: '<p>Hello <strong>world</strong></p>' }),
    );
    expect(html).toBe('<article><p>Hello <strong>world</strong></p></article>');
  });

  it('handles missing fields as empty string', () => {
    const html = renderItemTemplate('<p>{{missing}}</p>', item());
    expect(html).toBe('<p></p>');
  });

  it('uses the default template when none provided', () => {
    const html = renderItemTemplate(undefined, item({ title: 'Hi', body: '<p>x</p>' }));
    expect(html).toContain('<h1>Hi</h1>');
    expect(html).toContain('<p>x</p>');
  });

  it('stringifies numbers and booleans', () => {
    const html = renderItemTemplate('<p>{{count}} {{active}}</p>', item({ count: 42, active: true }));
    expect(html).toBe('<p>42 true</p>');
  });

  it('renders conditional sections only for non-empty values', () => {
    const template =
      '{{#pdf_url}}<a href="{{pdf_url}}">PDF</a>{{/pdf_url}}' +
      '{{#previous}}<a href="{{previous}}">Previous</a>{{/previous}}';

    expect(renderItemTemplate(template, item({ pdf_url: '', previous: '/one' })))
      .toBe('<a href="/one">Previous</a>');
    expect(renderItemTemplate(template, item({ pdf_url: null, previous: [] })))
      .toBe('');
  });

  it('supports nested conditional sections', () => {
    const template = '{{#download}}{{#pdf_url}}<a href="{{pdf_url}}">PDF</a>{{/pdf_url}}{{/download}}';
    expect(renderItemTemplate(template, item({ download: true, pdf_url: '/file.pdf' })))
      .toBe('<a href="/file.pdf">PDF</a>');
    expect(renderItemTemplate(template, item({ download: false, pdf_url: '/file.pdf' })))
      .toBe('');
  });
});

describe('buildCollectionRoutes', () => {
  function coll(over: Partial<CollectionDef> = {}): CollectionDef {
    return {
      id: 'restaurants',
      name: 'restaurants',
      label_singular: 'Restaurant',
      label_plural: 'Restaurants',
      fields: [],
      route_template: '/restaurants/{slug}',
      created_at: '2026-01-01',
      ...over,
    };
  }

  it('includes published items with resolvable paths', () => {
    const routes = buildCollectionRoutes(
      [coll()],
      new Map([['restaurants', [item({ slug: 'a' }), item({ slug: 'b' })]]]),
    );
    expect(routes.map((r) => r.path).sort()).toEqual(['/restaurants/a', '/restaurants/b']);
  });

  it('filters out drafts', () => {
    const routes = buildCollectionRoutes(
      [coll()],
      new Map([['restaurants', [
        item({ slug: 'a' }),
        { ...item({ slug: 'b' }), status: 'draft' },
      ]]]),
    );
    expect(routes.map((r) => r.path)).toEqual(['/restaurants/a']);
  });

  it('skips collections that opted out via route_template=""', () => {
    const routes = buildCollectionRoutes(
      [coll({ route_template: '' })],
      new Map([['restaurants', [item({ slug: 'a' })]]]),
    );
    expect(routes).toEqual([]);
  });

  it('skips items where a token resolves to empty', () => {
    const routes = buildCollectionRoutes(
      [coll()],
      new Map([['restaurants', [item({ title: 'no slug' })]]]),
    );
    expect(routes).toEqual([]);
  });

  it('resolves previous and next using the collection sort configuration', () => {
    const collection = coll({ sort_field: 'rank', sort_dir: 'asc' });
    const routes = buildCollectionRoutes(
      [collection],
      new Map([['restaurants', [
        item({ id: 'c', slug: 'c', title: 'C', rank: 3 }),
        item({ id: 'a', slug: 'a', title: 'A', rank: 1 }),
        item({ id: 'b', slug: 'b', title: 'B', rank: 2 }),
      ]]]),
    );
    const current = routes.find((route) => route.item.id === 'b')!;
    expect(collectionRouteNavigation(current, routes)).toEqual({
      previous: { id: 'a', title: 'A', url: '/restaurants/a' },
      next: { id: 'c', title: 'C', url: '/restaurants/c' },
    });
  });

  it('builds collection, generated taxonomy, and current-item breadcrumbs', () => {
    const collection = coll({
      label_plural: 'Checklists',
      route_template: '/checklists/{slug}',
      facets: [{ field: 'category', base_path: '/category', label_singular: 'Category', min_items: 1 }],
    });
    const routes = buildCollectionRoutes(
      [collection],
      new Map([['restaurants', [
        item({ id: 'energy', slug: 'energy', title: 'Save energy', category: 'Energy & climate' }),
      ]]]),
    );
    expect(collectionItemBreadcrumbs(routes[0]!, routes, 'always')).toEqual([
      { label: 'Checklists', href: '/checklists/' },
      { label: 'Energy & climate', href: '/category/energy-climate/' },
      { label: 'Save energy', href: '/checklists/energy/', current: true },
    ]);
  });

  it('omits the optional taxonomy crumb when the collection has no matching facet route', () => {
    const collection = coll({ label_plural: 'Articles', route_template: '/articles/{slug}' });
    const routes = buildCollectionRoutes(
      [collection],
      new Map([['restaurants', [item({ id: 'one', slug: 'one', title: 'One' })]]]),
    );
    expect(collectionItemBreadcrumbs(routes[0]!, routes)).toEqual([
      { label: 'Articles', href: '/articles' },
      { label: 'One', href: '/articles/one', current: true },
    ]);
  });

  it('builds parent-aware page breadcrumbs and stops safely on cycles', () => {
    const pages = [
      { id: 'home', title: 'Home', slug: '', content_mode: 'blocks', status: 'published' },
      { id: 'guides', title: 'Guides', slug: 'guides', path: '/guides', parent: 'home', content_mode: 'blocks', status: 'published' },
      { id: 'moving', title: 'Moving', slug: 'moving', path: '/guides/moving', parent: 'guides', content_mode: 'blocks', status: 'published' },
    ] as never;
    expect(pageBreadcrumbs(pages[2], pages, 'always')).toEqual([
      { label: 'Guides', href: '/guides/' },
      { label: 'Moving', href: '/guides/moving/', current: true },
    ]);
  });
});

describe('collectionFieldMatches', () => {
  it('matches scalar fields and membership in multi-value fields', () => {
    const record = { category_slug: 'transport', category_slugs: ['planning', 'transport'] };
    expect(collectionFieldMatches(record, 'category_slug', 'transport')).toBe(true);
    expect(collectionFieldMatches(record, 'category_slugs', 'transport')).toBe(true);
    expect(collectionFieldMatches(record, 'category_slugs', 'packing')).toBe(false);
  });
});
