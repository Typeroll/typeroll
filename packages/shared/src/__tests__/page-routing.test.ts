import { describe, it, expect } from 'vitest';
import type { BlockType, ContentType, Page } from '../types.js';
import { contentPagePath, pageContentValues } from '../page-content-model.js';
import { createPageSource } from '../page-source.js';
import { pageNavigation } from '../page-navigation.js';
import { pageBreadcrumbs } from '../page-breadcrumbs.js';
import { renderBlock } from '../render-blocks.js';
import { buildCoreBlockRegistry } from '../core-blocks.js';

const type = (over: Partial<ContentType> = {}): ContentType => ({ id: 'articles', name: 'articles', label_singular: 'Article', label_plural: 'Articles', fields: [], route_template: '/articles/{slug}', created_at: '2026-01-01', ...over });
const page = (over: Partial<Page> = {}): Page => ({ id: 'one', title: 'One', slug: 'one', content_type: 'articles', content_mode: 'blocks', blocks: [], status: 'published', ...over });

describe('native Page routing', () => {
  it('resolves slugs, nested custom values and segment encoding', () => {
    expect(contentPagePath(page(), type())).toBe('/articles/one');
    expect(contentPagePath(page({ fields: { date: '2024/01' }, slug: 'hello world' }), type({ route_template: '/blog/{date}/{slug}' }))).toBe('/blog/2024/01/hello%20world');
  });
  it('keeps URL-less content and missing route fields out of public routes', () => {
    expect(contentPagePath(page(), type({ route_template: '' }))).toBeNull();
    expect(contentPagePath(page({ slug: '' }), type())).toBeNull();
    expect(contentPagePath(page(), type({ route_template: '/{missing}/{slug}' }))).toBeNull();
  });
  it('normalizes routes and preserves explicit page addresses', () => {
    expect(contentPagePath(page(), type({ route_template: 'articles/{slug}/' }))).toBe('/articles/one');
    expect(contentPagePath(page({ path: '/old/address' }), type())).toBe('/old/address');
  });
  it('allows the default Page type homepage without special article identities', () => {
    expect(contentPagePath(page({ slug: '' }), type({ id: 'page', route_template: '/{slug}' }))).toBe('/');
    expect(contentPagePath(page({ slug: 'home' }), type())).toBe('/articles/home');
  });
  it('lists published pages while excluding drafts and unlisted pages', () => {
    const source = createPageSource([type()], [page(), page({ id: 'draft', status: 'draft' }), page({ id: 'unlisted', status: 'unlisted' })]);
    expect(source({}).map(result => result.id)).toEqual(['one']);
  });
  it('matches scalar custom fields and multi-value membership', () => {
    const source = createPageSource([type({ fields: [{ name: 'category', label: 'Category', type: 'text' }, { name: 'categories', label: 'Categories', type: 'list_simple' }] })], [page({ fields: { category: 'transport', categories: ['planning', 'transport'] } })]);
    expect(source({ filter_field: 'category', filter_value: 'transport' })).toHaveLength(1);
    expect(source({ filter_field: 'categories', filter_value: 'transport' })).toHaveLength(1);
    expect(source({ filter_field: 'categories', filter_value: 'packing' })).toEqual([]);
  });
});

describe('page template token rendering', () => {
  const render = (html: string, values: Partial<Page> = {}) => {
    const registry = buildCoreBlockRegistry();
    const layout: BlockType = { id: 'test/layout', name: 'layout', label: 'Layout', category: 'custom', container: false, schema: [], origin: 'user', created_at: '', template: html };
    registry.set(layout.id, layout);
    return renderBlock({ id: 'layout', type: layout.id, data: {} }, { registry, context: { page: pageContentValues(page(values)) } });
  };
  it('escapes text and preserves explicit rich text', () => {
    expect(render('<h1>{{page.title}}</h1>', { title: 'A <b>bold</b> claim' })).toContain('A &lt;b&gt;bold&lt;/b&gt; claim');
    expect(render('<article>{{{page.body}}}</article>', { html_content: '<p>Hello <strong>world</strong></p>' })).toContain('<p>Hello <strong>world</strong></p>');
  });
  it('renders missing fields as empty and interpolates numbers and booleans', () => {
    expect(render('<p>{{page.missing}}</p>')).toContain('<p></p>');
    expect(render('<p>{{page.count}} {{page.active}}</p>', { fields: { count: 42, active: true } })).toContain('<p>42 true</p>');
  });
  it('supports nested conditional sections without interpreting field values as templates', () => {
    const html = '{{#page.download}}{{#page.pdf_url}}<a href="{{page.pdf_url}}">PDF</a>{{/page.pdf_url}}{{/page.download}}';
    expect(render(html, { fields: { download: true, pdf_url: '/file.pdf' } })).toContain('href="/file.pdf"');
    expect(render(html, { fields: { download: false, pdf_url: '/file.pdf' } })).not.toContain('PDF');
    expect(render('{{#page.tags}}Tags{{/page.tags}}', { fields: { tags: [] } })).not.toContain('Tags');
  });
});

describe('native page navigation and breadcrumbs', () => {
  it('orders neighbors using custom fields and ignores other types and draft pages', () => {
    const pages = [page({ id: 'c', slug: 'c', title: 'C', fields: { rank: 3 } }), page({ id: 'a', slug: 'a', title: 'A', fields: { rank: 1 } }), page({ id: 'b', slug: 'b', title: 'B', fields: { rank: 2 } }), page({ id: 'd', status: 'draft', fields: { rank: 1.5 } }), page({ id: 'other', content_type: 'other', fields: { rank: 1.5 } })];
    expect(pageNavigation(pages[2], type({ sort_field: 'rank', sort_dir: 'asc' }), pages)).toEqual({ previous: { id: 'a', title: 'A', url: '/articles/a' }, next: { id: 'c', title: 'C', url: '/articles/c' } });
  });
  it('builds type root, taxonomy and current-page breadcrumbs', () => {
    const definition = type({ label_plural: 'Checklists', route_template: '/checklists/{slug}', facets: [{ field: 'category', base_path: '/category', label_singular: 'Category', min_items: 1 }] });
    const current = page({ title: 'Save energy', slug: 'energy', path: '/checklists/energy', fields: { category: 'Energy & climate' } });
    expect(pageBreadcrumbs(current, [current, page({ id: 'hub', path: '/checklists', slug: 'checklists' })], 'always', definition)).toEqual([
      { label: 'Checklists', href: '/checklists/' }, { label: 'Energy & climate', href: '/category/energy-climate/' }, { label: 'Save energy', href: '/checklists/energy/', current: true },
    ]);
  });
  it('omits taxonomy when no matching facet exists', () => {
    const current = page({ path: '/articles/one' });
    expect(pageBreadcrumbs(current, [current], 'ignore', type())).toEqual([{ label: 'One', href: '/articles/one', current: true }]);
  });
  it('prefers explicit parent hierarchy and stops on cycles', () => {
    const pages = [page({ id: 'home', title: 'Home', slug: '', path: '/' }), page({ id: 'guides', title: 'Guides', path: '/guides', parent: 'home' }), page({ id: 'moving', title: 'Moving', path: '/guides/moving', parent: 'guides' })];
    expect(pageBreadcrumbs(pages[2], pages, 'always')).toEqual([{ label: 'Guides', href: '/guides/' }, { label: 'Moving', href: '/guides/moving/', current: true }]);
    pages[0].parent = 'moving';
    expect(pageBreadcrumbs(pages[2], pages, 'always')).toHaveLength(2);
  });
});
