import { describe, expect, it } from 'vitest';
import { normalizeWordPressPlainText } from '../../lib/wp/plain-text';
import { projectItemFields } from '../../lib/wp/custom-types';

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

describe('WordPress collection field projection', () => {
  it('normalizes imported title and excerpt fields', () => {
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
    }, [], undefined, '<p>Body</p>');
    expect(fields.title).toBe('Flytta – enkelt');
    expect(fields.excerpt).toBe('Tryggt & smidigt');
  });
});
