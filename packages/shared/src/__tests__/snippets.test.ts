import { describe, expect, it } from 'vitest';
import { SNIPPET_CONTENT_AT_SOURCE, snippetContentAt, snippetFile, validateSnippet } from '../snippets.js';

const lunch = {
  id: 'lunch', name: "Today's lunch", kind: 'dated',
  entries: [
    { weekday: 'monday', content: '<p>Pea soup</p><script>x()</script>' },
    { weekday: 'tuesday', content: '<p>Fish</p>' },
    { date: '2026-11-10', content: '<p>Chef’s special</p>' },
  ],
  fallback: '<p>No lunch today</p>',
  updated_by: 'person:abc',
};
const sanitize = (html: string) => html.replace(/<script[\s\S]*?<\/script>/g, '');

describe('validateSnippet', () => {
  it('sanitizes HTML entries and keeps the structure', () => {
    const { snippet, errors } = validateSnippet(lunch, sanitize);
    expect(errors).toEqual([]);
    expect(snippet!.entries![0]).toEqual({ weekday: 'monday', content: '<p>Pea soup</p>' });
    expect(snippet!.format).toBe('html');
  });

  it('keeps text as typed and refuses bad dates, duplicates and missing keys', () => {
    expect(validateSnippet({ id: 'note', name: 'Note', kind: 'text', content: '<b>raw</b>' }).snippet!.content).toBe('<b>raw</b>');
    const { errors } = validateSnippet({ id: 'Bad', name: '', kind: 'dated', entries: [{ date: '2026-13-40', content: 'x' }, { content: 'y' }, { weekday: 'monday', content: 'a' }, { weekday: 'monday', content: 'b' }] });
    expect(errors.map((error) => error.path)).toEqual(['id', 'name', 'entries[0].date', 'entries[1]', 'entries[3]']);
  });

  it('refuses snippets over 64 KB', () => {
    expect(validateSnippet({ id: 'big', name: 'Big', kind: 'html', content: 'x'.repeat(70_000) }).errors[0]!.message).toMatch(/at most 64 KB/);
  });
});

describe('snippetContentAt', () => {
  const file = snippetFile(validateSnippet(lunch, sanitize).snippet!, 'Europe/Stockholm');
  const browser = new Function(`return (${SNIPPET_CONTENT_AT_SOURCE})`)() as (file: unknown, at: Date) => string;

  it('leaves out who wrote it from the public file', () => {
    expect(file).not.toHaveProperty('updated_by');
    expect(file.time_zone).toBe('Europe/Stockholm');
  });

  it('picks the dated entry over the weekday, the weekday otherwise, and the fallback last', () => {
    // Monday 9 Nov, Tuesday 10 Nov (dated special), Wednesday 11 Nov (fallback), all at noon in Stockholm.
    expect(snippetContentAt(file, new Date('2026-11-09T11:00:00Z'))).toBe('<p>Pea soup</p>');
    expect(snippetContentAt(file, new Date('2026-11-10T11:00:00Z'))).toBe('<p>Chef’s special</p>');
    expect(snippetContentAt(file, new Date('2026-11-11T11:00:00Z'))).toBe('<p>No lunch today</p>');
    // 23:30 UTC on Sunday is already Monday in Stockholm.
    expect(snippetContentAt(file, new Date('2026-11-08T23:30:00Z'))).toBe('<p>Pea soup</p>');
  });

  it('gives the same answer in the browser copy at every hour of two weeks', () => {
    for (let hour = 0; hour < 24 * 14; hour++) {
      const at = new Date(Date.UTC(2026, 10, 2, hour));
      expect(browser(file, at)).toBe(snippetContentAt(file, at));
    }
  });
});
