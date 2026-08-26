import { describe, it, expect } from 'vitest';
import {
  resolveItemPath,
  renderItemTemplate,
  buildCollectionRoutes,
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
});
