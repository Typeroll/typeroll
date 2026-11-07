/**
 * Site fields: settings pages a builder defines and editors fill in, like
 * WordPress options pages. Each group is a titled set of fields using the
 * same field model as content types; values are shared by the whole site and
 * reach templates as `{{site.fields.<name>}}`, the `core/site_field` block
 * and conditions (`site.fields.show_booking`). See
 * docs/plans/fonts-menus-fields-snippets-templates.md §3.
 */
import type { FieldDefinition, FieldType } from './types.js';

export interface SiteFieldGroup {
  id: string;
  label: string;
  description?: string;
  /**
   * Who may change the values: `editor` (anyone who edits content, the
   * default) or `admin` (administrators only). Definitions themselves are
   * always changed by administrators.
   */
  access?: 'editor' | 'admin';
  fields: FieldDefinition[];
}

export interface SiteFields {
  groups: SiteFieldGroup[];
  values: Record<string, unknown>;
  updated_at?: string;
}

export const SITE_FIELD_TYPES: readonly FieldType[] = [
  'text', 'textarea', 'richtext', 'boolean', 'number', 'select', 'multiselect',
  'date', 'datetime', 'image', 'url', 'email', 'page_ref', 'array', 'object',
] as FieldType[];
export const MAX_SITE_FIELD_GROUPS = 20;
export const MAX_SITE_FIELDS = 200;
const NAME = /^[a-z][a-z0-9_]{0,63}$/;
const GROUP_ID = /^[a-z][a-z0-9_-]{0,63}$/;

export interface SiteFieldError { path: string; message: string }

function checkField(field: unknown, path: string, depth: number, errors: SiteFieldError[], names: Set<string> | null): FieldDefinition | null {
  if (!field || typeof field !== 'object' || Array.isArray(field)) { errors.push({ path, message: 'A field is an object' }); return null; }
  const raw = field as Record<string, unknown>;
  const name = String(raw.name ?? '');
  const type = String(raw.type ?? '') as FieldType;
  if (!NAME.test(name)) errors.push({ path: `${path}.name`, message: 'Use lowercase letters, digits and underscores, starting with a letter' });
  else if (names) {
    if (names.has(name)) errors.push({ path: `${path}.name`, message: `The field name ${name} is already used on this site` });
    names.add(name);
  }
  if (!SITE_FIELD_TYPES.includes(type)) errors.push({ path: `${path}.type`, message: `Use one of ${SITE_FIELD_TYPES.join(', ')}` });
  const label = String(raw.label ?? '').trim();
  if (!label) errors.push({ path: `${path}.label`, message: 'Give the field a label' });
  if ((type === 'select' || type === 'multiselect') && !(Array.isArray(raw.options) && raw.options.length)) errors.push({ path: `${path}.options`, message: 'List the options' });
  const out: FieldDefinition = { ...(raw as unknown as FieldDefinition), name, type, label };
  if (type === 'array' || type === 'object') {
    if (depth >= 3) errors.push({ path: `${path}.fields`, message: 'Groups and lists nest at most three levels' });
    const nested = Array.isArray(raw.fields) ? raw.fields : [];
    if (!nested.length) errors.push({ path: `${path}.fields`, message: 'A list or group needs fields' });
    const local = new Set<string>();
    out.fields = nested.map((child, index) => checkField(child, `${path}.fields[${index}]`, depth + 1, errors, local)).filter((child): child is FieldDefinition => !!child);
  }
  return out;
}

/** Checks the groups and their fields; field names are unique across the site. */
export function validateSiteFieldGroups(input: unknown): { groups: SiteFieldGroup[]; errors: SiteFieldError[] } {
  const errors: SiteFieldError[] = [];
  if (!Array.isArray(input)) return { groups: [], errors: [{ path: 'groups', message: 'groups is a list' }] };
  if (input.length > MAX_SITE_FIELD_GROUPS) errors.push({ path: 'groups', message: `At most ${MAX_SITE_FIELD_GROUPS} settings pages` });
  const ids = new Set<string>();
  const names = new Set<string>();
  const groups = input.map((value, index): SiteFieldGroup | null => {
    const path = `groups[${index}]`;
    if (!value || typeof value !== 'object' || Array.isArray(value)) { errors.push({ path, message: 'A settings page is an object' }); return null; }
    const raw = value as Record<string, unknown>;
    const id = String(raw.id ?? '');
    if (!GROUP_ID.test(id)) errors.push({ path: `${path}.id`, message: 'Use lowercase letters, digits, - and _' });
    else if (ids.has(id)) errors.push({ path: `${path}.id`, message: 'Settings page ids must be unique' });
    ids.add(id);
    const label = String(raw.label ?? '').trim();
    if (!label) errors.push({ path: `${path}.label`, message: 'Give the settings page a title' });
    const access = raw.access === 'admin' ? 'admin' : 'editor';
    const fields = (Array.isArray(raw.fields) ? raw.fields : []).map((field, i) => checkField(field, `${path}.fields[${i}]`, 1, errors, names)).filter((field): field is FieldDefinition => !!field);
    return { id, label, access, fields, ...(typeof raw.description === 'string' && raw.description.trim() ? { description: raw.description.trim() } : {}) };
  }).filter((group): group is SiteFieldGroup => !!group);
  if (names.size > MAX_SITE_FIELDS) errors.push({ path: 'groups', message: `At most ${MAX_SITE_FIELDS} fields` });
  return { groups, errors };
}

const isDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));

function checkValue(field: FieldDefinition, value: unknown, path: string, errors: SiteFieldError[]): unknown {
  if (value === null || value === undefined || value === '') return undefined;
  const fail = (message: string) => { errors.push({ path, message }); return undefined; };
  switch (field.type) {
    case 'text': case 'textarea': case 'richtext': case 'email': case 'image': case 'page_ref':
      if (typeof value !== 'string') return fail('Text expected');
      if (value.length > (field.type === 'richtext' ? 20000 : 5000)) return fail('Too long');
      if (field.type === 'email' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) return fail('Not an email address');
      return value;
    case 'url':
      if (typeof value !== 'string' || /^\s*(javascript|data|vbscript):/i.test(value)) return fail('Not an allowed address');
      return value.trim();
    case 'boolean':
      if (typeof value !== 'boolean') return fail('true or false expected');
      return value;
    case 'number': {
      const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
      if (typeof n !== 'number' || !Number.isFinite(n)) return fail('A number expected');
      if (typeof field.min === 'number' && n < field.min) return fail(`At least ${field.min}`);
      if (typeof field.max === 'number' && n > field.max) return fail(`At most ${field.max}`);
      return n;
    }
    case 'select':
      if (!field.options?.includes(String(value))) return fail(`One of ${field.options?.join(', ')}`);
      return String(value);
    case 'multiselect':
      if (!Array.isArray(value) || value.some((item) => !field.options?.includes(String(item)))) return fail(`A list of ${field.options?.join(', ')}`);
      return value.map(String);
    case 'date':
      if (typeof value !== 'string' || !isDate(value)) return fail('A date like 2026-11-07');
      return value;
    case 'datetime':
      if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) return fail('A date and time like 2026-11-07T12:00');
      return value;
    case 'object': {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('A group of values expected');
      return checkValues(field.fields ?? [], value as Record<string, unknown>, path, errors);
    }
    case 'array': {
      if (!Array.isArray(value)) return fail('A list expected');
      if (typeof field.max_items === 'number' && value.length > field.max_items) return fail(`At most ${field.max_items} items`);
      if (typeof field.min_items === 'number' && value.length < field.min_items) return fail(`At least ${field.min_items} items`);
      return value.map((item, index) => (item && typeof item === 'object' && !Array.isArray(item)
        ? checkValues(field.fields ?? [], item as Record<string, unknown>, `${path}[${index}]`, errors)
        : fail(`${path}[${index}] is not a group of values`)));
    }
    default:
      return value;
  }
}

function checkValues(fields: FieldDefinition[], values: Record<string, unknown>, prefix: string, errors: SiteFieldError[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    const path = prefix ? `${prefix}.${field.name}` : field.name;
    const value = checkValue(field, values[field.name], path, errors);
    if (value === undefined) { if (field.required) errors.push({ path, message: `${field.label} is required` }); continue; }
    out[field.name] = value;
  }
  return out;
}

/**
 * Checks values against the groups' fields. Unknown names are reported;
 * `only` limits the check to some groups (an editor saving one page).
 */
export function validateSiteFieldValues(groups: SiteFieldGroup[], values: unknown, only?: string[]): { values: Record<string, unknown>; errors: SiteFieldError[] } {
  const errors: SiteFieldError[] = [];
  if (!values || typeof values !== 'object' || Array.isArray(values)) return { values: {}, errors: [{ path: 'values', message: 'values is an object' }] };
  const chosen = only ? groups.filter((group) => only.includes(group.id)) : groups;
  const fields = chosen.flatMap((group) => group.fields);
  const known = new Set(groups.flatMap((group) => group.fields.map((field) => field.name)));
  for (const name of Object.keys(values)) if (!known.has(name)) errors.push({ path: name, message: `No site field is called ${name}` });
  return { values: checkValues(fields, values as Record<string, unknown>, '', errors), errors };
}

export function siteFieldGroupOf(groups: SiteFieldGroup[], name: string): SiteFieldGroup | undefined {
  return groups.find((group) => group.fields.some((field) => field.name === name));
}

// ─── Opening hours ──────────────────────────────────────────────────────

export const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const;
export type Weekday = typeof WEEKDAYS[number];

/** A ready field for a week's opening hours plus dated exceptions (holidays). */
export function openingHoursField(name = 'opening_hours', label = 'Opening hours'): FieldDefinition {
  const time = (fieldName: string, fieldLabel: string): FieldDefinition => ({ name: fieldName, type: 'text', label: fieldLabel, placeholder: '09:00' });
  return {
    name, label, type: 'object', presentation: 'opening_hours',
    fields: [
      { name: 'days', label: 'Week', type: 'array', min_items: 7, max_items: 7, item_label: 'day', fields: [
        { name: 'day', label: 'Day', type: 'select', options: [...WEEKDAYS] },
        { name: 'closed', label: 'Closed', type: 'boolean' },
        time('opens', 'Opens'), time('closes', 'Closes'),
      ] },
      { name: 'exceptions', label: 'Exceptions', type: 'array', max_items: 60, item_label: 'date', fields: [
        { name: 'date', label: 'Date', type: 'date', required: true },
        { name: 'closed', label: 'Closed', type: 'boolean' },
        time('opens', 'Opens'), time('closes', 'Closes'), { name: 'note', label: 'Note', type: 'text' },
      ] },
    ],
  };
}

export interface OpeningHours {
  days?: Array<{ day?: string; closed?: boolean; opens?: string; closes?: string }>;
  exceptions?: Array<{ date?: string; closed?: boolean; opens?: string; closes?: string; note?: string }>;
}
export interface DayHours { date: string; weekday: Weekday; closed: boolean; opens?: string; closes?: string; note?: string; exception: boolean }

const TIME = /^([01]?\d|2[0-3]):([0-5]\d)$/;

/** The local calendar date and weekday in a time zone. */
export function localDate(at: Date, timeZone = 'Europe/Stockholm'): { date: string; weekday: Weekday; minutes: number } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'long', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(at).map((part) => [part.type, part.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, weekday: String(parts.weekday).toLowerCase() as Weekday, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

/** The hours of one date: an exception for that date wins over the weekday. */
export function hoursOn(hours: OpeningHours | undefined, date: string, weekday: Weekday): DayHours {
  const exception = hours?.exceptions?.find((entry) => entry.date === date);
  const source = exception ?? hours?.days?.find((entry) => entry.day === weekday);
  const valid = (value?: string) => (value && TIME.test(value) ? value.padStart(5, '0') : undefined);
  const opens = valid(source?.opens), closes = valid(source?.closes);
  return {
    date, weekday, exception: !!exception,
    closed: !source || source.closed === true || !opens || !closes,
    ...(opens ? { opens } : {}), ...(closes ? { closes } : {}),
    ...(exception?.note ? { note: exception.note } : {}),
  };
}

/** The coming `days` days from `at`, each with its hours. */
export function hoursAhead(hours: OpeningHours | undefined, at: Date, days = 7, timeZone?: string): DayHours[] {
  const out: DayHours[] = [];
  for (let i = 0; i < days; i++) {
    const { date, weekday } = localDate(new Date(at.getTime() + i * 86_400_000), timeZone);
    out.push(hoursOn(hours, date, weekday));
  }
  return out;
}

/** Whether it is open at `at`, and when it next opens or closes. */
export function openingStatus(hours: OpeningHours | undefined, at: Date, timeZone?: string): { open: boolean; until?: string; next?: DayHours } {
  const now = localDate(at, timeZone);
  const today = hoursOn(hours, now.date, now.weekday);
  const toMinutes = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
  if (!today.closed && today.opens && today.closes && now.minutes >= toMinutes(today.opens) && now.minutes < toMinutes(today.closes))
    return { open: true, until: today.closes };
  const upcoming = hoursAhead(hours, at, 14, timeZone);
  const next = upcoming.find((day, index) => !day.closed && (index > 0 || (day.opens && now.minutes < toMinutes(day.opens))));
  return { open: false, ...(next ? { next } : {}) };
}
