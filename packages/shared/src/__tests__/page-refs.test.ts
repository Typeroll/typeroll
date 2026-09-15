import { describe, it, expect } from 'vitest';
import type { ContentType, Page } from '../types.js';
import { backlinksFor, buildBacklinkIndex, expandPageRefs, refFields, refIds } from '../page-refs.js';

const articles: Pick<ContentType, 'id' | 'fields'> = { id: 'articles', fields: [
  { name: 'mentions', type: 'page_ref_list', label: 'Mentions', ref_content_type: 'companies' },
  { name: 'sponsor', type: 'page_ref', label: 'Sponsor', ref_content_type: 'companies' },
  { name: 'related', type: 'page_ref', label: 'Any page' },
] };
const companies: Pick<ContentType, 'id' | 'fields'> = { id: 'companies', fields: [] };
const page = (id: string, type = 'articles', fields: Record<string, unknown> = {}): Page => ({
  id, title: id, slug: id, content_type: type, content_mode: 'blocks', status: 'published', fields,
});

describe('page reference fields', () => {
  it('supports both constrained and unrestricted references', () => {
    expect(refFields(articles).map(ref => [ref.field.name, ref.many, ref.target])).toEqual([
      ['mentions', true, 'companies'], ['sponsor', false, 'companies'], ['related', false, undefined],
    ]);
  });
  it('normalizes scalar, list, empty and malformed reference values', () => {
    expect(refIds('c1')).toEqual(['c1']); expect(refIds(['c1', 'c2'])).toEqual(['c1', 'c2']);
    for (const input of ['', undefined, null, 42]) expect(refIds(input)).toEqual([]);
    expect(refIds([null, 'c1', 42, ''])).toEqual(['c1']);
  });
});

describe('derived page backlinks', () => {
  const index = buildBacklinkIndex([articles, companies], [
    page('a1', 'articles', { mentions: ['c1', 'c2'], sponsor: 'c1' }),
    page('a2', 'articles', { mentions: ['c2'] }), page('a3'),
    page('c1', 'companies'), page('c2', 'companies'), page('c3', 'companies'),
  ]);
  it('groups and labels referencing pages by their type', () => {
    expect(backlinksFor(index, 'c2')).toEqual([{ content_type: 'articles', id: 'a1' }, { content_type: 'articles', id: 'a2' }]);
  });
  it('filters source types and deduplicates multiple references from one page', () => {
    expect(backlinksFor(index, 'c2', 'articles')).toHaveLength(2);
    expect(backlinksFor(index, 'c2', 'other')).toEqual([]);
    expect(backlinksFor(index, 'c1')).toEqual([{ content_type: 'articles', id: 'a1' }]);
  });
  it('returns empty results for missing and unreferenced pages', () => {
    expect(backlinksFor(index, 'c3')).toEqual([]); expect(backlinksFor(index, 'missing')).toEqual([]);
    expect(backlinksFor(index, 'a1')).toEqual([]);
  });
});

describe('one-level page reference expansion', () => {
  const lookup = (id: string) => id === 'c1' ? { ...page(id, 'companies'), title: 'Acme' } : undefined;
  it('expands a single reference and keeps its raw ID available', () => {
    const out = expandPageRefs(page('a1', 'articles', { sponsor: 'c1' }), articles, lookup);
    expect((out.sponsor as Record<string, unknown>).title).toBe('Acme'); expect(out.sponsor_id).toBe('c1');
  });
  it('retains dangling references and leaves lists for repeaters', () => {
    const out = expandPageRefs(page('a1', 'articles', { sponsor: 'gone', mentions: ['c1'] }), articles, lookup);
    expect(out.sponsor).toBe('gone'); expect(out.mentions).toEqual(['c1']);
  });
  it('rejects a target of the wrong type and allows unconstrained targets', () => {
    const lookup = (id: string) => page(id, 'page');
    const out = expandPageRefs(page('a1', 'articles', { sponsor: 'p1', related: 'p1' }), articles, lookup);
    expect(out.sponsor).toBe('p1'); expect((out.related as Record<string, unknown>).id).toBe('p1');
  });
  it('keeps common page values for types with no reference fields', () => {
    expect(expandPageRefs(page('c1', 'companies'), companies, lookup)).toMatchObject({ id: 'c1', title: 'c1', fields: {} });
  });
});
