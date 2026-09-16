import { describe, expect, it } from 'vitest';
import { planTaxonomyImport } from '../../lib/wp/taxonomy-import';
import type { WPTerm, WPItem } from '../../lib/wp/client';

const taxonomy = { slug: 'category', name: 'Categories', rest_base: 'categories', types: ['post', 'news'], hierarchical: true };
const term = (id: number, parent = 0): WPTerm => ({ id, parent, name: `Category ${id}`, slug: `cat-${id}`, link: `https://source.example/category/${id}/` });
const plan = (terms: WPTerm[]) => planTaxonomyImport([{ taxonomy, terms }], 'https://source.example', '2026-09-16');

describe('normalized taxonomy import', () => {
  it('creates editable tag pages with listings while preserving one category parent and source paths', () => {
    const result = planTaxonomyImport([
      { taxonomy, terms: [term(1)] },
      { taxonomy: { slug: 'post_tag', name: 'Tags', rest_base: 'tags', types: ['post'], hierarchical: false },
        terms: [
          { ...term(7), link: 'https://source.example/tag/moving/', description: '<p>Unique tag introduction</p>' },
          { ...term(8), link: 'https://source.example/tag/packing/' },
        ] },
    ], 'https://source.example', '2026-09-16');
    const article = { categories: [1], tags: [7, 8] } as unknown as WPItem;
    expect(result.valuesFor(article, 'post')).toEqual({
      wp_taxonomy_category: ['wp-term-category-1'],
      wp_taxonomy_post_tag: ['wp-term-post_tag-7', 'wp-term-post_tag-8'],
    });
    expect(result.parentFor(article, 'post')).toBe('wp-term-category-1');
    const tag = result.pages.find(page => page.id === 'wp-term-post_tag-7')!;
    expect(tag).toMatchObject({ path: '/tag/moving', content_mode: 'blocks' });
    expect(tag.parent).toBeUndefined();
    expect(JSON.stringify(tag.blocks)).toContain('Unique tag introduction');
    expect(tag.blocks?.find(block => block.type === 'core/repeater')?.data).toMatchObject({ source_type: 'backlinks', limit: 0 });
  });
  it('preserves term metadata and hierarchy only on the shared page', () => {
    const result = plan([term(1), { ...term(2, 1), acf: { emoji: '📦' }, description: '<p>Shared description</p>' }]);
    expect(result.pages[1]).toMatchObject({ parent: 'wp-term-category-1', fields: { emoji: '📦' }, path: '/category/2' });
    expect(result.pages[1].blocks?.some(block => block.type === 'core/prose')).toBe(true);
    expect(result.valuesFor({ categories: [2, 1, 2] } as unknown as WPItem, 'post')).toEqual({ wp_taxonomy_category: ['wp-term-category-2', 'wp-term-category-1'] });
    expect(result.fieldsFor('page')).toEqual([]);
  });
  it('uses helper term IDs without copying their labels into article data', () => {
    const result = plan([term(1)]);
    expect(result.valuesFor({ _taxonomies: { category: [{ id: 1, name: 'Duplicated label' }] } } as unknown as WPItem, 'news'))
      .toEqual({ wp_taxonomy_category: ['wp-term-category-1'] });
  });
  it('rejects dangling parents, cycles and conflicting archive URLs', () => {
    expect(() => plan([term(2, 99)])).toThrow('Missing parent term');
    expect(() => plan([term(1, 2), term(2, 1)])).toThrow('parent cycle');
    expect(() => plan([{ ...term(1), link: 'https://other.example/archive' }])).toThrow('Missing local archive URL');
  });
});

it('uses only an unambiguous or explicit primary category for breadcrumbs', () => {
  const result = plan([term(1), term(2)]);
  expect(result.parentFor({ categories: [1] } as unknown as WPItem, 'post')).toBe('wp-term-category-1');
  expect(result.parentFor({ categories: [1, 2] } as unknown as WPItem, 'post')).toBeUndefined();
  expect(result.parentFor({ categories: [1, 2], _primary_terms: { category: 2 } } as unknown as WPItem, 'post')).toBe('wp-term-category-2');
  expect(() => result.parentFor({ categories: [1], _primary_terms: { category: 2 } } as unknown as WPItem, 'post')).toThrow('not assigned');
});

it('finds custom fields beyond the first WordPress record and refuses incompatible values', async () => {
  const { inferContentType } = await import('../../lib/wp/custom-types');
  const type = { slug: 'news', name: 'News', rest_base: 'news-items' };
  expect(inferContentType(type, [{ acf: { first: 'value' } }, { acf: { later: true } }] as unknown as WPItem[]).fields.map(field => field.name)).toContain('later');
  expect(() => inferContentType(type, [{ acf: { value: true } }, { acf: { value: 'text' } }] as unknown as WPItem[])).toThrow('Inconsistent WordPress field');
});
