import { describe, expect, it } from 'vitest';
import { createPageSource } from '../page-source.js';
import { contentPagePath, DEFAULT_CONTENT_TYPE, resolveContentPage } from '../page-content-model.js';
import { buildBacklinkIndex, backlinksFor, expandPageRefs } from '../page-refs.js';
import { pageNavigation } from '../page-navigation.js';
import type { ContentType, Page } from '../types.js';
const type = (id: string, patch: Partial<ContentType> = {}): ContentType => ({ ...DEFAULT_CONTENT_TYPE, id, name: id, route_template: `/${id}/{slug}`, ...patch });
const page = (id: string, patch: Partial<Page> = {}): Page => ({ id, title: id, slug: id, content_type: 'article', content_mode: 'blocks', blocks: [], status: 'published', ...patch });

describe('one page content model', () => {
  it('queries routed and unrouted pages while excluding drafts and unlisted pages', () => {
    const query = createPageSource([type('article'), type('person', { route_template: '' })], [
      page('article'), page('person', { content_type: 'person' }), page('draft', { status: 'draft' }), page('hidden', { status: 'unlisted' }),
    ]);
    expect(query({}).map(page => [page.id, page.url])).toEqual([['article', '/article/article'], ['person', '']]);
    expect(query({ ids: ['person', 'article'] }).map(page => page.id)).toEqual(['person', 'article']);
  });
  it('preserves custom paths and never writes computed defaults into source data', () => {
    const original = page('p', { fields: { year: '2024/01' } });
    const definition = type('article', { route_template: '/{year}/{slug}', template: 'article-shell' });
    expect(resolveContentPage(original, definition)).toMatchObject({ path: '/2024/01/p', template: 'article-shell' });
    expect(original).not.toHaveProperty('path');
    expect(contentPagePath({ ...original, path: '/old-address' }, definition)).toBe('/old-address');
    expect(contentPagePath(original, type('article', { route_template: '/{missing}/{slug}' }))).toBeNull();
  });
  it('does not expose provenance or fields marked private through queries', () => {
    const query = createPageSource([type('article', { fields: [{ name: 'secret', label: 'Secret', type: 'text', rendered: false }, { name: 'excerpt', label: 'Excerpt', type: 'text' }] })], [
      { ...page('p', { fields: { secret: 'internal', excerpt: 'Public', undeclared: 'Hidden value' } }), _provenance: { secret: { source: 'portal', actor: 'editor', updated_at: '2026-01-01' } } } as Page,
    ]);
    expect(JSON.stringify(query({}))).not.toContain('internal');
    expect(JSON.stringify(query({}))).not.toContain('_provenance');
    expect(query({})[0]?.excerpt).toBe('Public');
    expect(JSON.stringify(query({}))).not.toContain('Hidden value');
  });
  it('uses global IDs for references and derives backlinks across content types', () => {
    const article = type('article', { fields: [{ name: 'mentions', label: 'Mentions', type: 'page_ref_list' }] });
    const pages = [page('a', { fields: { mentions: ['b', 'b', 'c'] } }), page('b', { content_type: 'person' })];
    const index = buildBacklinkIndex([article, type('person')], pages);
    expect(backlinksFor(index, 'b')).toEqual([{ id: 'a', content_type: 'article' }]);
    expect(backlinksFor(index, 'b', 'person')).toEqual([]);
  });
  it('expands references one level and respects optional type constraints', () => {
    const article = type('article', { fields: [{ name: 'author', label: 'Author', type: 'page_ref', ref_content_type: 'person' }] });
    const current = page('a', { fields: { author: 'b' } });
    const author = page('b', { content_type: 'person', fields: { author: 'a' } });
    expect(expandPageRefs(current, article, () => author)).toMatchObject({ author_id: 'b', author: { id: 'b', fields: { author: 'a' } } });
    expect(expandPageRefs(current, article, () => page('b')).author).toBe('b');
  });
  it('uses type sort order for neighbouring pages, without crossing types', () => {
    const definition = type('article', { sort_field: 'rank', sort_dir: 'asc' });
    const pages = [page('c', { fields: { rank: 3 } }), page('a', { fields: { rank: 1 } }), page('b', { fields: { rank: 2 } }), page('person', { content_type: 'person' })];
    expect(pageNavigation(pages[2]!, definition, pages)).toEqual({ previous: { id: 'a', title: 'a', url: '/article/a' }, next: { id: 'c', title: 'c', url: '/article/c' } });
  });
});

describe('content type sorting defaults', () => {
  const records = [page('c', { sort_order: 2, fields: { rank: 20 } }), page('a', { sort_order: 8, fields: { rank: 3 } }), page('b', { sort_order: 1, fields: { rank: 10 } }), page('missing')];
  const definition = type('article', { fields: [{ name: 'rank', label: 'Rank', type: 'number' }], sort_field: 'rank', sort_dir: 'desc' });
  it('inherits custom numeric order, with missing values last and explicit overrides', () => {
    const query = createPageSource([definition], records);
    expect(query({ content_type: 'article' }).map(page => page.id)).toEqual(['c', 'b', 'a', 'missing']);
    expect(query({ content_type: 'article', sort_by: 'sort_order', sort_order: 'asc' }).map(page => page.id)).toEqual(['b', 'c', 'a', 'missing']);
    expect(query({ content_type: 'article', ids: ['a', 'c', 'b'], sort_by: 'rank' }).map(page => page.id)).toEqual(['a', 'c', 'b']);
    expect(query({ content_type: 'article', pinned_ids: ['a'], limit: 2 }).map(page => page.id)).toEqual(['a', 'c']);
    expect(pageNavigation(records[2], definition, records).previous?.id).toBe('c');
  });
  it('uses manual order without type settings and stable IDs for ties', () => {
    const query = createPageSource([type('article')], [page('z', { sort_order: 0 }), ...records, page('d', { sort_order: 0 }), page('negative-five', { sort_order: -5 }), page('negative-ten', { sort_order: -10 })]);
    expect(query({ content_type: 'article' }).map(page => page.id)).toEqual(['negative-ten', 'negative-five', 'd', 'z', 'b', 'c', 'a', 'missing']);
  });
});
