// Pure helpers behind the snippet pages: the week model, date rows, the PUT
// body, error mapping and the "this week" preview.

import { describe, expect, it } from 'vitest';
import { validateSnippet, type Snippet } from '@typeroll/shared';
import {
  addDateRow, addDays, buildSnippet, clearWeek, copyWeekday, draftSignature, isBlank, localProblems, mapSnippetErrors,
  liveSupported, plainText, previewDays, snippetSaveBody, sortDateRows, suggestSnippetId, toDraft, weekdayOf, newSnippet, describeUpdated,
} from '../../components/snippet-model';

const lunch: Snippet = {
  id: 'lunch', name: 'Lunch', kind: 'dated', format: 'html',
  entries: [
    { date: '2026-11-12', content: '<p>Fish soup</p>' },
    { weekday: 'monday', content: '<p>Meatballs</p>' },
    { weekday: 'tuesday', content: '<p>Pasta</p>' },
    { date: '2026-11-10', content: '<p>Closed</p>' },
  ],
  fallback: '<p>No lunch today</p>',
  updated_at: '2026-11-07T10:00:00.000Z', updated_by: 'anna@example.com',
};

describe('the week model', () => {
  it('reads weekday entries into seven rows and dates in order', () => {
    const draft = toDraft(lunch);
    expect(Object.keys(draft.week)).toEqual(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']);
    expect(draft.week.monday).toBe('<p>Meatballs</p>');
    expect(draft.week.wednesday).toBe('');
    expect(draft.dates.map((row) => row.date)).toEqual(['2026-11-10', '2026-11-12']);
    expect(draft.fallback).toBe('<p>No lunch today</p>');
  });

  it('copies Monday to Tuesday–Friday and clears the week', () => {
    const copied = copyWeekday(toDraft(lunch));
    expect(['tuesday', 'wednesday', 'thursday', 'friday'].map((day) => copied.week[day as 'friday'])).toEqual(Array(4).fill('<p>Meatballs</p>'));
    expect(copied.week.saturday).toBe('');
    const cleared = clearWeek(copied);
    expect(Object.values(cleared.week).every((value) => value === '')).toBe(true);
    expect(cleared.dates).toHaveLength(2);
  });

  it('builds a valid snippet: weekdays first, dates sorted, blank days left out', () => {
    const draft = toDraft(lunch);
    draft.week.wednesday = '<p><br></p>';
    draft.dates = [{ key: 'b', date: '2026-12-24', content: '<p>Christmas buffet</p>' }, ...draft.dates, { key: 'c', date: '2026-12-31', content: '' }];
    const { snippet, sources } = buildSnippet({ id: 'lunch', kind: 'dated' }, draft);
    expect(snippet.entries).toEqual([
      { weekday: 'monday', content: '<p>Meatballs</p>' },
      { weekday: 'tuesday', content: '<p>Pasta</p>' },
      { date: '2026-11-10', content: '<p>Closed</p>' },
      { date: '2026-11-12', content: '<p>Fish soup</p>' },
      { date: '2026-12-24', content: '<p>Christmas buffet</p>' },
    ]);
    expect(sources).toEqual(['weekday:monday', 'weekday:tuesday', `date:${draft.dates[1]!.key}`, `date:${draft.dates[2]!.key}`, 'date:b']);
    expect(validateSnippet(snippet).errors).toEqual([]);
  });

  it('sends the whole snippet with the updated_at it was read at', () => {
    const body = snippetSaveBody({ id: 'notice', kind: 'text' }, { ...toDraft(newSnippet('notice', 'Notice', 'text')), content: 'Closed Monday' }, '2026-11-07T10:00:00.000Z');
    expect(body).toEqual({ id: 'notice', name: 'Notice', kind: 'text', format: 'text', content: 'Closed Monday', expected_updated_at: '2026-11-07T10:00:00.000Z' });
  });

  it('ignores row keys and order when telling unsaved changes', () => {
    const draft = toDraft(lunch);
    const reordered = { ...draft, dates: [...draft.dates].reverse().map((row, i) => ({ ...row, key: `x${i}` })) };
    expect(draftSignature('dated', reordered)).toBe(draftSignature('dated', draft));
    expect(draftSignature('dated', { ...draft, fallback: '<p>Closed</p>' })).not.toBe(draftSignature('dated', draft));
  });
});

describe('date rows', () => {
  it('sorts by date and keeps rows without a date last', () => {
    const rows = sortDateRows([{ key: 'a', date: '', content: 'x' }, { key: 'b', date: '2026-12-24', content: '' }, { key: 'c', date: '2026-11-09', content: '' }]);
    expect(rows.map((row) => row.key)).toEqual(['c', 'b', 'a']);
  });

  it('adds a row on the first free day', () => {
    const draft = toDraft({ ...lunch, entries: [{ date: '2026-11-07', content: 'x' }, { date: '2026-11-08', content: 'y' }] });
    const next = addDateRow(draft, '2026-11-07');
    expect(next.dates.at(-1)!.date).toBe('2026-11-09');
  });

  it('finds a missing date and a date used twice before saving', () => {
    const draft = { ...toDraft(lunch), dates: [
      { key: 'a', date: '2026-11-09', content: 'x' }, { key: 'b', date: '2026-11-09', content: 'y' }, { key: 'c', date: '', content: 'z' }, { key: 'd', date: '', content: '' },
    ] };
    expect(localProblems(draft, 'dated')).toEqual([
      { path: 'date:b', message: '2026-11-09 already has an entry' },
      { path: 'date:c', message: 'Pick a date' },
    ]);
    expect(localProblems({ ...draft, name: ' ' }, 'html')).toEqual([{ path: 'name', message: 'Give the snippet a name' }]);
  });
});

describe('error mapping', () => {
  it('puts entry errors on the row they came from', () => {
    const sources = ['weekday:monday', 'date:k1'] as const;
    const map = mapSnippetErrors([
      { path: 'entries[1].date', message: 'A date like 2026-11-09' },
      { path: 'entries[0].content', message: 'Text expected' },
      { path: 'name', message: 'Give the snippet a name' },
      { path: '', message: 'The snippet is 70 KB' },
      { path: 'entries', message: 'At most 400 entries' },
    ], [...sources]);
    expect(map.get('date:k1')).toEqual(['A date like 2026-11-09']);
    expect(map.get('weekday:monday')).toEqual(['Text expected']);
    expect(map.get('name')).toEqual(['Give the snippet a name']);
    expect(map.get('')).toEqual(['The snippet is 70 KB', 'At most 400 entries']);
  });
});

describe('the week preview', () => {
  it('shows each of the next seven days by the site time zone, a date before its weekday', () => {
    // 23:30 UTC on Sunday 8 November is already Monday 9 November in Stockholm.
    const days = previewDays(buildSnippet({ id: 'lunch', kind: 'dated' }, toDraft(lunch)).snippet, 'Europe/Stockholm', new Date('2026-11-08T23:30:00Z'));
    expect(days.map((day) => `${day.date} ${day.weekday} ${day.source}`)).toEqual([
      '2026-11-09 monday weekday', '2026-11-10 tuesday date', '2026-11-11 wednesday fallback', '2026-11-12 thursday date',
      '2026-11-13 friday fallback', '2026-11-14 saturday fallback', '2026-11-15 sunday fallback',
    ]);
    expect(days[0]!.content).toBe('<p>Meatballs</p>');
    expect(days[1]!.content).toBe('<p>Closed</p>');
    expect(days[2]!.content).toBe('<p>No lunch today</p>');
    expect(previewDays(lunch, 'UTC', new Date('2026-11-08T23:30:00Z'))[0]!.date).toBe('2026-11-08');
  });

  it('crosses a daylight saving change without skipping a day', () => {
    const days = previewDays({ kind: 'dated', entries: [] }, 'Europe/Stockholm', new Date('2026-10-24T22:30:00Z'));
    expect(days.map((day) => day.date)).toEqual(['2026-10-25', '2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31']);
    expect(days.every((day) => day.source === 'none')).toBe(true);
  });

  it('works out calendar days and weekdays without a time zone', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(weekdayOf('2026-11-09')).toBe('monday');
    expect(weekdayOf('2026-11-15')).toBe('sunday');
  });
});

describe('small helpers', () => {
  it('suggests a unique id from the name', () => {
    expect(suggestSnippetId('Dagens lunch', [])).toBe('dagens-lunch');
    expect(suggestSnippetId('Café öppet!', ['cafe-oppet'])).toBe('cafe-oppet-2');
    expect(suggestSnippetId('!!!', [])).toBe('snippet');
  });

  it('tells blank content and makes plain text', () => {
    expect(isBlank('<p><br></p>', 'html')).toBe(true);
    expect(isBlank('<p>&nbsp;</p>', 'html')).toBe(true);
    expect(isBlank('<p><img src="/a.png"></p>', 'html')).toBe(false);
    expect(isBlank('  ', 'text')).toBe(true);
    expect(plainText('<p>Fish &amp; chips</p><p>Salad</p>', 'html')).toBe('Fish & chips\nSalad');
  });

  it('reads live support from the flag or the base address', () => {
    expect(liveSupported({ supported: false, base_url: 'https://x' })).toBe(false);
    expect(liveSupported({ base_url: null, reason: 'No bucket' })).toBe(false);
    expect(liveSupported({ base_url: 'https://media.example/live/' })).toBe(true);
    expect(liveSupported(undefined)).toBe(true);
  });

  it('says who updated last', () => {
    expect(describeUpdated({})).toBe('—');
    expect(describeUpdated({ updated_at: '2026-11-07T10:00:00.000Z', updated_by: 'anna@example.com' }, 'en-GB')).toMatch(/2026.* by anna@example\.com$/);
  });
});
