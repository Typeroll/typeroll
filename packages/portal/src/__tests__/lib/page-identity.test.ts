// What a built page says about itself. These are a contract: once a customer
// styles against one, renaming it breaks their site.

import { describe, expect, it } from 'vitest';
import { pageIdentityAttributes, routeKind, routeDepth } from '@typeroll/shared';

const page = (over: Record<string, unknown> = {}) =>
  ({ id: 'p1', path: '/guides/packing/', content_type: 'page', ...over }) as never;

describe('route kind', () => {
  it('distinguishes the kinds a build can honestly tell apart', () => {
    expect(routeKind({ page: page({ path: '/' }) })).toBe('home');
    expect(routeKind({ page: page(), facet: { field: 'city', value: 'malmo' } })).toBe('facet');
    expect(routeKind({ page: page({ content_type: 'article' }), defaultContentType: 'page' })).toBe('item');
    expect(routeKind({ page: page() })).toBe('page');
  });

  it('treats a facet as a facet even when its page is typed', () => {
    // A facet route is generated over a content type; it is not that item.
    expect(routeKind({ page: page({ content_type: 'article' }), facet: { field: 'tag', value: 'x' } })).toBe('facet');
  });
});

describe('the attributes on <body>', () => {
  it('omits what it does not know rather than emitting it empty', () => {
    // The whole point: [data-template] must mean "has a template" and never
    // match a page without one.
    const bare = pageIdentityAttributes({ page: page({ template: null, content_type: undefined }) });
    expect(bare['data-template']).toBeUndefined();
    expect(bare['data-content-type']).toBeUndefined();
    expect('data-template' in bare).toBe(false);
    expect(Object.values(bare).every((value) => value !== '')).toBe(true);
  });

  it('carries the facet field and value where a facet route has them', () => {
    const facet = pageIdentityAttributes({ page: page(), facet: { field: 'city', value: 'malmo' } });
    expect(facet).toMatchObject({ 'data-route': 'facet', 'data-facet-field': 'city', 'data-facet-value': 'malmo' });
  });

  it('numbers only the slices that are not the first', () => {
    // Page 1 is the page's own URL, so [data-page-number] means "not page 1".
    expect(pageIdentityAttributes({ page: page(), pageNum: 1 })['data-page-number']).toBeUndefined();
    expect(pageIdentityAttributes({ page: page(), pageNum: 3 })['data-page-number']).toBe('3');
  });

  it('reports depth below the root', () => {
    expect(routeDepth('/')).toBe(0);
    expect(routeDepth('/guides/')).toBe(1);
    expect(routeDepth('/guides/packing/')).toBe(2);
    expect(pageIdentityAttributes({ page: page({ path: '/' }) })['data-depth']).toBe('0');
  });

  it('always names the route, so a stylesheet can rely on one attribute existing', () => {
    for (const p of [page({ path: '/' }), page(), page({ content_type: 'article' })]) {
      expect(pageIdentityAttributes({ page: p, defaultContentType: 'page' })['data-route']).toBeTruthy();
    }
  });
});
