/**
 * Live snippets: small pieces of content a site keeps outside its
 * publication. Each is written as a static JSON file in the site's media
 * bucket (`live/<snippet>.json`) the moment it is saved; the `core/snippet`
 * block shows the value from the latest publication and the browser then
 * fetches the newest file. Content can be keyed by date or weekday ("today's
 * lunch"), so a week's entries are written once and the page picks today's.
 * See docs/plans/fonts-menus-fields-snippets-templates.md §4.
 */
import { localDate, WEEKDAYS, type Weekday } from './site-fields.js';

export type SnippetKind = 'html' | 'text' | 'dated';

export interface SnippetEntry {
  /** A calendar date (YYYY-MM-DD); wins over a weekday. */
  date?: string;
  weekday?: Weekday;
  /** HTML (sanitized on save) or plain text, as the snippet's `format`. */
  content: string;
}

export interface Snippet {
  id: string;
  name: string;
  kind: SnippetKind;
  /** `html` (sanitized) or `text`; dated entries use the same format. */
  format?: 'html' | 'text';
  /** `html` and `text` snippets. */
  content?: string;
  /** `dated` snippets: entries by date or weekday. */
  entries?: SnippetEntry[];
  /** Shown on a day without an entry. */
  fallback?: string;
  /** Who last wrote it: a person, an agent or an app installation. */
  updated_by?: string;
  updated_at?: string;
}

/** The public file a snippet is published as. */
export interface SnippetFile {
  id: string;
  kind: SnippetKind;
  format: 'html' | 'text';
  content?: string;
  entries?: SnippetEntry[];
  fallback?: string;
  time_zone?: string;
  updated_at: string;
}

export const MAX_SNIPPET_BYTES = 64 * 1024;
export const MAX_SNIPPETS = 100;
export const MAX_SNIPPET_ENTRIES = 400;
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface SnippetError { path: string; message: string }

/**
 * Checks a snippet. `sanitize` cleans HTML content (Core's published-page
 * sanitizer); text is kept as typed and escaped when rendered.
 */
export function validateSnippet(input: unknown, sanitize: (html: string) => string = (html) => html): { snippet: Snippet | null; errors: SnippetError[] } {
  const errors: SnippetError[] = [];
  const add = (path: string, message: string) => errors.push({ path, message });
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { snippet: null, errors: [{ path: '', message: 'A snippet is an object' }] };
  const raw = input as Record<string, unknown>;
  const id = String(raw.id ?? '');
  if (!ID.test(id)) add('id', 'Use lowercase letters, digits, - and _ (at most 64)');
  const name = String(raw.name ?? '').trim();
  if (!name || name.length > 120) add('name', 'Give the snippet a name (at most 120 characters)');
  const kind = String(raw.kind ?? '') as SnippetKind;
  if (!['html', 'text', 'dated'].includes(kind)) add('kind', 'Use html, text or dated');
  const format: 'html' | 'text' = kind === 'text' || raw.format === 'text' ? 'text' : 'html';
  const clean = (value: unknown, path: string) => {
    if (typeof value !== 'string') { add(path, 'Text expected'); return ''; }
    return format === 'html' ? sanitize(value) : value;
  };
  const snippet: Snippet = { id, name, kind, format };
  if (kind === 'html' || kind === 'text') snippet.content = clean(raw.content ?? '', 'content');
  if (kind === 'dated') {
    const entries = Array.isArray(raw.entries) ? raw.entries : [];
    if (!Array.isArray(raw.entries)) add('entries', 'entries is a list');
    if (entries.length > MAX_SNIPPET_ENTRIES) add('entries', `At most ${MAX_SNIPPET_ENTRIES} entries`);
    const seen = new Set<string>();
    snippet.entries = entries.slice(0, MAX_SNIPPET_ENTRIES).map((value, index) => {
      const path = `entries[${index}]`;
      const entry = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
      const date = typeof entry.date === 'string' ? entry.date : undefined;
      const weekday = typeof entry.weekday === 'string' ? entry.weekday as Weekday : undefined;
      if (date && (!DATE.test(date) || Number.isNaN(Date.parse(date)))) add(`${path}.date`, 'A date like 2026-11-09');
      if (weekday && !(WEEKDAYS as readonly string[]).includes(weekday)) add(`${path}.weekday`, `One of ${WEEKDAYS.join(', ')}`);
      if (!date && !weekday) add(path, 'Give a date or a weekday');
      const key = date ?? weekday ?? '';
      if (key && seen.has(key)) add(path, `${key} has two entries`);
      seen.add(key);
      return { ...(date ? { date } : {}), ...(!date && weekday ? { weekday } : {}), content: clean(entry.content ?? '', `${path}.content`) };
    });
    if (raw.fallback !== undefined && raw.fallback !== null) snippet.fallback = clean(raw.fallback, 'fallback');
  }
  for (const key of ['updated_by', 'updated_at'] as const) if (typeof raw[key] === 'string') snippet[key] = raw[key] as string;
  const bytes = new TextEncoder().encode(JSON.stringify(snippet)).length;
  if (bytes > MAX_SNIPPET_BYTES) add('', `The snippet is ${Math.round(bytes / 1024)} KB; at most ${MAX_SNIPPET_BYTES / 1024} KB`);
  return { snippet: errors.length ? null : snippet, errors };
}

/** The public file for a snippet (never includes who wrote it). */
export function snippetFile(snippet: Snippet, timeZone?: string): SnippetFile {
  return {
    id: snippet.id, kind: snippet.kind, format: snippet.format ?? (snippet.kind === 'text' ? 'text' : 'html'),
    ...(snippet.content !== undefined ? { content: snippet.content } : {}),
    ...(snippet.entries ? { entries: snippet.entries } : {}),
    ...(snippet.fallback !== undefined ? { fallback: snippet.fallback } : {}),
    ...(timeZone ? { time_zone: timeZone } : {}),
    updated_at: snippet.updated_at ?? new Date(0).toISOString(),
  };
}

/** What a snippet shows at `at`: its content, or today's entry (a date wins over a weekday). */
export function snippetContentAt(file: Pick<SnippetFile, 'kind' | 'content' | 'entries' | 'fallback' | 'time_zone'>, at: Date): string {
  if (file.kind !== 'dated') return file.content ?? '';
  const { date, weekday } = localDate(at, file.time_zone || 'Europe/Stockholm');
  const entry = file.entries?.find((item) => item.date === date) ?? file.entries?.find((item) => !item.date && item.weekday === weekday);
  return entry?.content ?? file.fallback ?? '';
}

/**
 * The same choice in plain ES5 for the page's script, kept equal to
 * `snippetContentAt` by tests: given the file and a Date, it returns the
 * content to show.
 */
export const SNIPPET_CONTENT_AT_SOURCE = `function(file, at){
  if (file.kind !== 'dated') return file.content || '';
  var parts = {};
  new Intl.DateTimeFormat('en-GB', { timeZone: file.time_zone || 'Europe/Stockholm', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'long' })
    .formatToParts(at).forEach(function (part) { parts[part.type] = part.value; });
  var date = parts.year + '-' + parts.month + '-' + parts.day, weekday = String(parts.weekday).toLowerCase();
  var entries = file.entries || [], i;
  for (i = 0; i < entries.length; i++) if (entries[i].date === date) return entries[i].content;
  for (i = 0; i < entries.length; i++) if (!entries[i].date && entries[i].weekday === weekday) return entries[i].content;
  return file.fallback || '';
}`;
