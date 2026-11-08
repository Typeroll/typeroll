// Pure helpers for the snippet pages: the editing draft (a week of weekday
// entries plus specific dates), the PUT body, error mapping and the "this
// week" preview. The components in SnippetEditor.tsx and SnippetList.tsx
// stay thin around these.

import {
  localDate, siteTimeZone, snippetContentAt, WEEKDAYS,
  type Snippet, type SnippetEntry, type SnippetError, type SnippetKind, type Weekday,
} from '@typeroll/shared';

/** The zone used when the page passes none: the shared default. */
export const DEFAULT_TIME_ZONE = siteTimeZone(undefined);

export const KIND_LABELS: Record<SnippetKind, string> = { text: 'Text', html: 'Rich text', dated: 'By day/date' };

export const WEEKDAY_NAMES: Record<Weekday, string> = {
  monday: 'Monday', tuesday: 'Tuesday', wednesday: 'Wednesday', thursday: 'Thursday', friday: 'Friday', saturday: 'Saturday', sunday: 'Sunday',
};

/** A specific-date row; `key` keeps the row stable while its date changes. */
export interface DateRow { key: string; date: string; content: string }

export interface SnippetDraft {
  name: string;
  format: 'html' | 'text';
  /** html and text snippets. */
  content: string;
  /** dated snippets: one value per weekday ('' = none). */
  week: Record<Weekday, string>;
  dates: DateRow[];
  fallback: string;
}

/** Where a server error belongs in the editor. */
export type ErrorTarget = 'name' | 'content' | 'fallback' | `weekday:${Weekday}` | `date:${string}` | '';

const emptyWeek = (): Record<Weekday, string> => Object.fromEntries(WEEKDAYS.map((day) => [day, ''])) as Record<Weekday, string>;

export function snippetFormat(snippet: Pick<Snippet, 'kind' | 'format'>): 'html' | 'text' {
  return snippet.kind === 'text' || snippet.format === 'text' ? 'text' : 'html';
}

/** Whether content shows nothing: no text and no media once tags are gone. */
export function isBlank(content: string | undefined, format: 'html' | 'text'): boolean {
  if (!content) return true;
  if (format === 'text') return content.trim() === '';
  if (/<(img|video|iframe|svg|hr)\b/i.test(content)) return false;
  return content.replace(/<[^>]*>/g, '').replace(/&nbsp;|&#160;| /g, ' ').trim() === '';
}

/** Dates in order; rows without a date last, in the order they were added. */
export function sortDateRows(rows: DateRow[]): DateRow[] {
  return rows.map((row, index) => ({ row, index }))
    .sort((a, b) => (a.row.date && b.row.date ? a.row.date.localeCompare(b.row.date) : a.row.date ? -1 : b.row.date ? 1 : 0) || a.index - b.index)
    .map(({ row }) => row);
}

let rowCounter = 0;
export const newRowKey = () => `row${Date.now().toString(36)}${(rowCounter++).toString(36)}`;

export function toDraft(snippet: Snippet): SnippetDraft {
  const week = emptyWeek();
  const dates: DateRow[] = [];
  for (const [index, entry] of (snippet.entries ?? []).entries()) {
    if (entry.date) dates.push({ key: `d${index}`, date: entry.date, content: entry.content ?? '' });
    else if (entry.weekday && !week[entry.weekday]) week[entry.weekday] = entry.content ?? '';
  }
  return {
    name: snippet.name,
    format: snippetFormat(snippet),
    content: snippet.content ?? '',
    week,
    dates: sortDateRows(dates),
    fallback: snippet.fallback ?? '',
  };
}

/** A draft compared for "unsaved changes": row keys and row order don't count. */
export function draftSignature(kind: SnippetKind, draft: SnippetDraft): string {
  return JSON.stringify(buildSnippet({ id: '', kind }, draft).snippet);
}

/**
 * The snippet a draft saves as, plus where each entry came from so server
 * errors on `entries[i]` land on the right row. Blank weekdays and blank
 * dates are left out, so those days show the fallback.
 */
export function buildSnippet(base: Pick<Snippet, 'id' | 'kind'>, draft: SnippetDraft): { snippet: Snippet; sources: ErrorTarget[] } {
  const { kind } = base;
  const snippet: Snippet = { id: base.id, name: draft.name.trim(), kind, format: kind === 'text' ? 'text' : kind === 'html' ? 'html' : draft.format };
  const sources: ErrorTarget[] = [];
  if (kind !== 'dated') {
    snippet.content = draft.content;
    return { snippet, sources };
  }
  const format = snippet.format!;
  const entries: SnippetEntry[] = [];
  for (const day of WEEKDAYS) {
    if (isBlank(draft.week[day], format)) continue;
    entries.push({ weekday: day, content: draft.week[day] });
    sources.push(`weekday:${day}`);
  }
  for (const row of sortDateRows(draft.dates)) {
    if (isBlank(row.content, format)) continue;
    entries.push({ ...(row.date ? { date: row.date } : {}), content: row.content });
    sources.push(`date:${row.key}`);
  }
  snippet.entries = entries;
  if (!isBlank(draft.fallback, format)) snippet.fallback = draft.fallback;
  return { snippet, sources };
}

/** The body of a PUT: the whole snippet's fields plus the updated_at it was read at. */
export function snippetSaveBody(base: Pick<Snippet, 'id' | 'kind'>, draft: SnippetDraft, expectedUpdatedAt: string | undefined): Record<string, unknown> {
  return { ...buildSnippet(base, draft).snippet, ...(expectedUpdatedAt ? { expected_updated_at: expectedUpdatedAt } : {}) };
}

/** Problems the editor finds before saving: dates missing or used twice. */
export function localProblems(draft: SnippetDraft, kind: SnippetKind): SnippetError[] {
  const errors: SnippetError[] = [];
  if (!draft.name.trim()) errors.push({ path: 'name', message: 'Give the snippet a name' });
  if (kind !== 'dated') return errors;
  const seen = new Map<string, string>();
  for (const row of draft.dates) {
    if (!row.date) {
      if (!isBlank(row.content, draft.format)) errors.push({ path: `date:${row.key}`, message: 'Pick a date' });
      continue;
    }
    if (seen.has(row.date)) errors.push({ path: `date:${row.key}`, message: `${row.date} already has an entry` });
    else seen.set(row.date, row.key);
  }
  return errors;
}

/**
 * Server errors (paths such as `entries[2].content`) by editor target. A
 * local problem's path is already a target (`date:<key>`, `name`).
 */
export function mapSnippetErrors(errors: SnippetError[], sources: ErrorTarget[]): Map<ErrorTarget, string[]> {
  const map = new Map<ErrorTarget, string[]>();
  const add = (target: ErrorTarget, message: string) => map.set(target, [...(map.get(target) ?? []), message]);
  for (const error of errors) {
    const path = error.path ?? '';
    const entry = /^entries\[(\d+)\]/.exec(path);
    if (entry) { add(sources[Number(entry[1])] ?? '', error.message); continue; }
    if (path === 'name' || path === 'content' || path === 'fallback') { add(path, error.message); continue; }
    if (/^(weekday|date):/.test(path)) { add(path as ErrorTarget, error.message); continue; }
    add('', error.message);
  }
  return map;
}

/** Monday's content on the given days (default Tuesday–Friday). */
export function copyWeekday(draft: SnippetDraft, from: Weekday = 'monday', to: Weekday[] = ['tuesday', 'wednesday', 'thursday', 'friday']): SnippetDraft {
  const week = { ...draft.week };
  for (const day of to) week[day] = draft.week[from];
  return { ...draft, week };
}

export function clearWeek(draft: SnippetDraft): SnippetDraft {
  return { ...draft, week: emptyWeek() };
}

/** A new date row: the first day from `from` on that has no row yet. */
export function addDateRow(draft: SnippetDraft, from: string): SnippetDraft {
  const taken = new Set(draft.dates.map((row) => row.date));
  let date = from;
  for (let i = 0; i < 366 && taken.has(date); i++) date = addDays(date, 1);
  return { ...draft, dates: [...draft.dates, { key: newRowKey(), date: taken.has(date) ? '' : date, content: '' }] };
}

export function updateDateRow(draft: SnippetDraft, key: string, patch: Partial<Omit<DateRow, 'key'>>): SnippetDraft {
  return { ...draft, dates: draft.dates.map((row) => (row.key === key ? { ...row, ...patch } : row)) };
}

export function removeDateRow(draft: SnippetDraft, key: string): SnippetDraft {
  return { ...draft, dates: draft.dates.filter((row) => row.key !== key) };
}

/** A calendar date `n` days later (YYYY-MM-DD, time-zone free). */
export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + n)).toISOString().slice(0, 10);
}

/** The weekday of a calendar date, independent of any time zone. */
export function weekdayOf(date: string): Weekday {
  const [y, m, d] = date.split('-').map(Number);
  return WEEKDAYS[(new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay() + 6) % 7]!;
}

/** Today's date in the site's time zone. */
export function todayIn(timeZone: string | undefined, now = new Date()): string {
  try { return localDate(now, timeZone || DEFAULT_TIME_ZONE).date; } catch { return localDate(now, DEFAULT_TIME_ZONE).date; }
}

export interface PreviewDay { date: string; weekday: Weekday; content: string; source: 'date' | 'weekday' | 'fallback' | 'none' }

/**
 * What the snippet shows on each of `count` days from today in the site's
 * time zone. Each day is read with `snippetContentAt` at noon UTC of that
 * calendar date with the UTC time zone, so the choice is the page's own and
 * no daylight-saving change can skip or repeat a day.
 */
export function previewDays(snippet: Pick<Snippet, 'kind' | 'content' | 'entries' | 'fallback'>, timeZone: string | undefined, now = new Date(), count = 7): PreviewDay[] {
  const start = todayIn(timeZone, now);
  return Array.from({ length: count }, (_, i) => {
    const date = addDays(start, i);
    const [y, m, d] = date.split('-').map(Number);
    const at = new Date(Date.UTC(y!, m! - 1, d!, 12));
    const weekday = weekdayOf(date);
    const content = snippetContentAt({ ...snippet, time_zone: 'UTC' }, at);
    const source = snippet.entries?.some((entry) => entry.date === date) ? 'date'
      : snippet.entries?.some((entry) => !entry.date && entry.weekday === weekday) ? 'weekday'
      : snippet.fallback !== undefined && snippet.fallback !== '' ? 'fallback' : 'none';
    return { date, weekday, content, source };
  });
}

/** A snippet id from its name: lowercase letters, digits and -, unique. */
export function suggestSnippetId(name: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const base = name.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 56) || 'snippet';
  const start = /^[a-z0-9]/.test(base) ? base : `s-${base}`;
  if (!used.has(start)) return start;
  for (let i = 2; ; i++) if (!used.has(`${start}-${i}`)) return `${start}-${i}`;
}

/** A new, empty snippet of a kind. */
export function newSnippet(id: string, name: string, kind: SnippetKind): Snippet {
  if (kind === 'dated') return { id, name: name.trim(), kind, format: 'html', entries: [] };
  return { id, name: name.trim(), kind, format: kind === 'text' ? 'text' : 'html', content: '' };
}

/** Plain text of content for short previews (the list and the week preview). */
export function plainText(content: string, format: 'html' | 'text'): string {
  if (format === 'text') return content;
  return content.replace(/<(br|\/p|\/li|\/h[2-4])\s*\/?>/gi, '\n').replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\n{2,}/g, '\n').trim();
}

/**
 * Whether the site's live files can be written: `supported` when the API
 * says so, else whether it names a base address for them.
 */
export function liveSupported(live: { supported?: boolean; base_url?: string | null; reason?: string } | null | undefined): boolean {
  if (!live) return true;
  return typeof live.supported === 'boolean' ? live.supported : live.base_url !== null;
}

/** Who and when, for "last updated". */
export function describeUpdated(snippet: Pick<Snippet, 'updated_at' | 'updated_by'>, locale?: string): string {
  if (!snippet.updated_at) return '—';
  const at = new Date(snippet.updated_at);
  const when = Number.isNaN(at.getTime()) ? snippet.updated_at : at.toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' });
  return snippet.updated_by ? `${when} by ${snippet.updated_by}` : when;
}
