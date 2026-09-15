import { describe, expect, it } from 'vitest';
import { normalizeWordPressPlainText } from '../../lib/wp/plain-text';
import { inferContentType, projectItemFields } from '../../lib/wp/custom-types';

describe('normalizeWordPressPlainText', () => {
  it('decodes named and numeric HTML entities exactly once', () => {
    expect(normalizeWordPressPlainText('Caf&eacute; &#8211; A &amp; B')).toBe('Café – A & B');
    expect(normalizeWordPressPlainText('&amp;lt;em&amp;gt;literal&amp;lt;/em&amp;gt;')).toBe(
      '&lt;em&gt;literal&lt;/em&gt;',
    );
  });

  it('removes markup from fields whose contract is plain text', () => {
    expect(normalizeWordPressPlainText('<strong>Flytta</strong> &amp; städa')).toBe('Flytta & städa');
  });

  it('preserves already-normalized punctuation, accents, and comparisons', () => {
    const value = 'Café – 5 < 10 & 3 > 2 “quoted”';
    expect(normalizeWordPressPlainText(value)).toBe(value);
  });
});

describe('WordPress custom field projection', () => {
  it('normalizes excerpts while leaving the Page title to the common importer', () => {
    const fields = projectItemFields({
      id: 7,
      slug: 'flytta',
      status: 'publish',
      link: 'https://old.example.com/flytta/',
      date: '2026-09-05T12:00:00Z',
      modified: '2026-09-05T12:00:00Z',
      title: { rendered: '<b>Flytta</b> &#8211; enkelt' },
      content: { rendered: '<p>Body</p>' },
      excerpt: { rendered: 'Tryggt &amp; smidigt' },
    }, [{ name: 'excerpt', label: 'Excerpt', type: 'textarea' }], undefined);
    expect(fields.title).toBeUndefined();
    expect(fields.excerpt).toBe('Tryggt & smidigt');
  });
});

it('preserves normalized WordPress fields without colliding with Page metadata', () => {
  const item = { acf: { title: 'Custom heading', 'room-count': 3, summary: 'ACF summary' }, meta: { summary: 'Meta summary' } } as any;
  const type = inferContentType({ slug: 'property', name: 'Property', rest_base: 'property' } as any, item);
  expect(type.fields.map(field => field.name)).toEqual(expect.arrayContaining(['wp_title', 'room_count', 'summary', 'meta_summary']));
  expect(projectItemFields(item, type.fields, undefined)).toMatchObject({ wp_title: 'Custom heading', room_count: 3, summary: 'ACF summary', meta_summary: 'Meta summary' });
  expect(projectItemFields(item, [], undefined)).toEqual({});
});
it('reports colliding source field names instead of silently discarding one', () => {
  expect(() => inferContentType({ slug: 'test' } as any, { acf: { 'room-count': 2, room_count: 3 } } as any)).toThrow('field names collide');
});
