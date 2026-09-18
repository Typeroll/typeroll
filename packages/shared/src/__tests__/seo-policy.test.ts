import { describe, it, expect } from 'vitest';
import { breadcrumbJsonLd, pageRobots, schemaFieldMapError, seoReviewError } from '../seo-policy.js';
import { pageBreadcrumbs } from '../page-breadcrumbs.js';
import { resolveContentPage } from '../page-content-model.js';
import type { ContentType, Page } from '../types.js';

describe('resolved breadcrumb SEO', () => {
  const type = { id: 'supplier', label_plural: 'Companies', route_template: '/companies/{slug}/', fields: [] } as unknown as ContentType;
  for (const [slug, explicitPath, expected] of [
    ['abc', undefined, '/companies/abc/'], ['nested/abc', undefined, '/companies/nested/abc/'],
    ['abc', '/special/abc/', '/special/abc/'],
  ]) for (const slash of ['always', 'never'] as const) it(`uses resolved ${expected} (${slash})`, () => {
    const raw = { id: 'abc', slug, path: explicitPath, title: 'ABC', status: 'published', content_type: 'supplier' } as Page;
    const page = resolveContentPage(raw, type)!;
    const pathname = slash === 'never' ? expected!.replace(/\/$/, '') : expected!;
    const breadcrumbs = pageBreadcrumbs(page, [page, { id: 'hub', slug: 'companies', title: 'Companies', status: 'published' } as Page], slash, type);
    const schema = JSON.parse(breadcrumbJsonLd({ pathname, canonical: 'https://example.test' + pathname, baseUrl: 'https://example.test', title: 'ABC', siteName: 'Example', breadcrumbs })!);
    expect(schema.itemListElement.at(-1).item).toBe('https://example.test' + pathname);
    expect(schema.itemListElement[1].item).toBe('https://example.test/companies' + (slash === 'always' ? '/' : ''));
  });
  it('omits homepage and honors an explicit cross-domain canonical', () => {
    const args = { pathname: '/', canonical: 'https://example.test/', baseUrl: 'https://example.test', title: 'Home', siteName: 'Example', breadcrumbs: [] };
    expect(breadcrumbJsonLd(args)).toBeNull();
    const schema = JSON.parse(breadcrumbJsonLd({ ...args, pathname: '/article/', canonical: 'https://original.test/article/' })!);
    expect(schema.itemListElement.at(-1).item).toBe('https://original.test/article/');
  });
});
describe('independent robots policies', () => {
  it('follows links on intentionally noindex public pages', () => {
    expect(pageRobots({}, {})).toBe('index,follow');
    expect(pageRobots({ noindex: true }, {})).toBe('noindex,follow');
    expect(pageRobots({ noindex: true, nofollow: true }, {})).toBe('noindex,nofollow');
    expect(pageRobots({}, { sitewide_noindex: true })).toBe('noindex,follow');
    expect(pageRobots({}, {}, true)).toBe('noindex,nofollow');
  });
});
describe('schema mappings and editorial constraints', () => {
  it('accepts flat maps but rejects unsupported nesting and prototype keys', () => {
    expect(schemaFieldMapError({ company: 'name' })).toBeNull();
    for (const key of ['address.addressLocality', '__proto__', 'constructor', 'prototype', 'address.__proto__.city']) expect(schemaFieldMapError({ city: key })).toContain('schema_field_map.city');
    expect(schemaFieldMapError({ city: { address: 'addressLocality' } })).toContain('schema_field_map.city');
    expect(schemaFieldMapError(null)).toBeNull();
  });
  it('validates review constraints without claiming to judge facts automatically', () => {
    expect(seoReviewError({ forbidden_markers: ['wave-1'], claims: [{ phrase: 'compare earnings', guidance: 'Review whether supported.' }], notes: ['Prefer fewer supported facts.'] })).toBeNull();
    expect(seoReviewError({ claims: [{ phrase: 'compare' }] })).toBeTruthy();
    expect(seoReviewError({ forbidden_markers: [''] })).toBeTruthy();
  });
});
