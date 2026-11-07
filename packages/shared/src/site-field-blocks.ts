/**
 * Site fields on pages: the `core/site_field` block, which shows one value of
 * the site's fields inline, and the `core/show_if` container, which shows its
 * blocks only when a condition (`site.fields.show_booking`) holds. Values
 * reach the render context as `site.fields` (siteFieldValues); definitions
 * stay out of it and only pick a format (`siteFieldDefinitions`).
 *
 * Opening-hours formats that depend on the date (today's hours, open now, the
 * next opening, this week) are computed when the page is built and refreshed
 * in the browser by SITE_FIELD_CLOCK_SCRIPT, which recomputes them from the
 * hours embedded in `data-site-field-clock`. Without script the build-time
 * value shows. siteFieldClockHtml and the script's SITE_FIELD_CLOCK_COMPUTE
 * are the same algorithm, checked against each other in the tests.
 */
import type { Block, BlockType, FieldDefinition } from './types.js';
import type { SiteFieldGroup, SiteFields } from './site-fields.js';
import { WEEKDAYS, localDate } from './site-fields.js';
import { formatDisplayDate, openingHoursText, type OpeningHoursText } from './ui-text.js';

const ISO_EPOCH = '1970-01-01T00:00:00.000Z';
export const DEFAULT_SITE_TIME_ZONE = 'Europe/Stockholm';

export const SITE_FIELD_FORMATS = [
  'auto', 'text', 'richtext', 'number', 'date', 'list',
  'opening_hours_week', 'opening_hours_today', 'next_opening', 'open_now',
] as const;
export type SiteFieldFormat = typeof SITE_FIELD_FORMATS[number];
/** Formats whose output depends on the date and time they are shown at. */
export const SITE_FIELD_CLOCK_FORMATS: ReadonlySet<string> = new Set(['opening_hours_week', 'opening_hours_today', 'next_opening', 'open_now']);

export const SITE_FIELD_BLOCK: BlockType = {
  id: 'core/site_field',
  name: 'site_field',
  label: 'Site field',
  icon: 'clock',
  category: 'content',
  container: false,
  parts: [
    { name: 'label', label: 'Label', selector: '.block-site-field-label', target: 'text' },
    { name: 'value', label: 'Value', selector: '.block-site-field-value', target: 'text' },
    { name: 'day', label: 'Weekdays', selector: '.block-site-field-hours th', target: 'text' },
    { name: 'hours', label: 'Hours of a day', selector: '.block-site-field-hours td', target: 'text' },
    { name: 'today', label: 'Today in the week', selector: '.block-site-field-hours tr[data-today]', target: 'text' },
  ],
  schema: [
    { name: 'field', type: 'text', label: 'Site field', required: true, placeholder: 'phone',
      help: 'The name of a site field. Use a dot for a value inside a group or list, for example contact.phone.' },
    { name: 'format', type: 'select', label: 'Show as', options: [...SITE_FIELD_FORMATS],
      option_labels: ['Automatic (by the field)', 'Text', 'Rich text', 'Number', 'Date', 'List', 'Opening hours: this week', 'Opening hours: today', 'Next opening', 'Open now or closed'],
      default: 'auto' },
    { name: 'label', type: 'text', label: 'Label (optional)', help: 'Shown before the value, or as the caption of the week.' },
    { name: 'empty_text', type: 'text', label: 'Text when empty', help: 'Shown when the field has no value. Without it the block renders nothing.' },
    { name: 'tag', type: 'select', label: 'HTML element', options: ['p', 'span', 'div'], default: 'p',
      help: 'The week, lists and rich text always use div.' },
    { name: 'style_id', type: 'style', label: 'Style', style_target: 'text', editor_group: 'content' },
  ],
  template: '<{{=tag}} data-block="site_field" data-format="{{site_field_format}}"{{#site_field_empty}} data-empty="true"{{/site_field_empty}}>{{{site_field_html}}}</{{=tag}}>',
  styles: `
[data-block="site_field"] { margin: 0; }
[data-block="site_field"] .block-site-field-hours { border-collapse: collapse; }
[data-block="site_field"] .block-site-field-hours caption { text-align: start; }
[data-block="site_field"] .block-site-field-hours th { text-align: start; font-weight: inherit; padding: 0.15em 1.5em 0.15em 0; }
[data-block="site_field"] .block-site-field-hours td { padding: 0.15em 0; }
[data-block="site_field"] .block-site-field-list { margin: 0; }
`.trim(),
  origin: 'core',
  created_at: ISO_EPOCH,
};

export const SHOW_IF_BLOCK: BlockType = {
  id: 'core/show_if',
  name: 'show_if',
  label: 'Show if',
  icon: 'eye',
  category: 'layout',
  container: 'conditional',
  schema: [
    { name: 'condition', type: 'text', label: 'Condition', placeholder: 'site.fields.show_booking',
      help: 'The blocks inside show only when this is true. Examples: site.fields.show_booking (a checkbox is ticked), !site.fields.closed (not ticked), site.fields.season === "winter", page.language === "en". Join conditions with && or ||. A condition that cannot be read hides the blocks.' },
  ],
  origin: 'core',
  created_at: ISO_EPOCH,
};

export const SITE_FIELD_BLOCK_TYPES: readonly BlockType[] = [SITE_FIELD_BLOCK, SHOW_IF_BLOCK];

// ─── Values in the render context ───────────────────────────────────────

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

function publicValues(fields: readonly FieldDefinition[], values: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    if (field.rendered === false || !Object.hasOwn(values, field.name)) continue;
    const value = values[field.name];
    if (field.type === 'object' && isRecord(value) && field.fields) out[field.name] = publicValues(field.fields, value);
    else if (field.type === 'array' && Array.isArray(value) && field.fields) out[field.name] = value.map(item => (isRecord(item) ? publicValues(field.fields!, item) : item));
    else out[field.name] = value;
  }
  return out;
}

/**
 * The site's field values as templates read them (`{{site.fields.*}}`):
 * only values of defined fields, without private (`rendered: false`) ones.
 * Definitions stay out of the context.
 */
export function siteFieldValues(fields: Pick<SiteFields, 'groups' | 'values'> | null | undefined): Record<string, unknown> {
  if (!fields || !isRecord(fields.values)) return {};
  return publicValues((fields.groups ?? []).flatMap(group => group.fields ?? []), fields.values);
}

function siteFieldDefinition(groups: readonly Pick<SiteFieldGroup, 'fields'>[] | undefined, path: string[]): FieldDefinition | undefined {
  let fields: readonly FieldDefinition[] = (groups ?? []).flatMap(group => group.fields ?? []);
  let found: FieldDefinition | undefined;
  for (const segment of path) {
    if (/^\d+$/.test(segment) && found?.type === 'array') continue;
    found = fields.find(field => field.name === segment);
    if (!found) return undefined;
    fields = found.fields ?? [];
  }
  return found;
}

function valueAt(values: unknown, path: string[]): unknown {
  let current = values;
  for (const segment of path) {
    if (Array.isArray(current) && /^\d+$/.test(segment)) current = current[Number(segment)];
    else if (isRecord(current) && Object.hasOwn(current, segment)) current = current[segment];
    else return undefined;
  }
  return current;
}

/** The field names a `core/site_field` block or a condition reads, for publication warnings. */
export function siteFieldPath(name: unknown): string[] {
  const text = String(name ?? '').trim().replace(/^site\.fields\./, '');
  return text && /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/i.test(text) ? text.split('.') : [];
}

// ─── Opening hours on a date ────────────────────────────────────────────

/**
 * What a date-dependent format needs, embedded as JSON in the page so the
 * browser can recompute it: format, time zone, the week and exceptions,
 * weekday names (Monday first) and labels in the page language.
 */
export interface SiteFieldClockInput {
  f: string;
  z: string;
  d: Array<{ day?: string; closed?: boolean; opens?: string; closes?: string }>;
  x: Array<{ date?: string; closed?: boolean; opens?: string; closes?: string; note?: string }>;
  w: string[];
  t: OpeningHoursText;
}

const TIME = /^([01]?\d|2[0-3]):([0-5]\d)$/;
const escapeText = (value: unknown) => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
const fill = (template: string, name: string, value: string) => template.split(`{${name}}`).join(value);

/**
 * The output of a date-dependent format at `now`: the text of today's hours,
 * open now or the next opening, or the rows of this week (Monday first).
 * SITE_FIELD_CLOCK_COMPUTE is the same function for the browser.
 */
export function siteFieldClockHtml(input: SiteFieldClockInput, now: Date): string {
  const parts: Record<string, string> = {};
  for (const part of new Intl.DateTimeFormat('en-GB', { timeZone: input.z, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now)) parts[part.type] = part.value;
  const year = Number(parts.year), month = Number(parts.month), date = Number(parts.day);
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  const valid = (value: unknown) => (typeof value === 'string' && TIME.test(value) ? (value.length === 4 ? `0${value}` : value) : '');
  const hours = (offset: number) => {
    const day = new Date(Date.UTC(year, month - 1, date + offset));
    const iso = day.toISOString().slice(0, 10), index = (day.getUTCDay() + 6) % 7;
    const exception = (input.x ?? []).find(entry => entry && entry.date === iso);
    const source = exception ?? (input.d ?? []).find(entry => entry && entry.day === WEEKDAYS[index]);
    const opens = valid(source?.opens), closes = valid(source?.closes);
    return { index, closed: !source || source.closed === true || !opens || !closes, opens, closes, note: exception?.note ? String(exception.note) : '' };
  };
  const text = (day: ReturnType<typeof hours>) => (day.closed ? escapeText(input.t.closed) : escapeText(`${day.opens}–${day.closes}`)) + (day.note ? ` (${escapeText(day.note)})` : '');
  const toMinutes = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
  const today = hours(0);
  const open = !today.closed && minutes >= toMinutes(today.opens) && minutes < toMinutes(today.closes);
  const until = escapeText(fill(input.t.open_until, 'time', today.closes));
  if (input.f === 'opening_hours_today') return text(today);
  if (input.f === 'open_now') return open ? until : escapeText(input.t.closed);
  if (input.f === 'next_opening') {
    if (open) return until;
    for (let offset = 0; offset < 14; offset++) {
      const day = offset ? hours(offset) : today;
      if (!day.closed && (offset > 0 || minutes < toMinutes(day.opens))) {
        const name = offset === 0 ? input.t.today : offset === 1 ? input.t.tomorrow : String(input.w[day.index] ?? '');
        return escapeText(fill(fill(input.t.opens, 'day', name), 'time', day.opens));
      }
    }
    return escapeText(input.t.closed);
  }
  let rows = '';
  for (let index = 0; index < 7; index++) {
    const day = hours(index - today.index);
    const name = String(input.w[index] ?? '');
    rows += `<tr data-day="${WEEKDAYS[index]}"${index === today.index ? ' data-today="true" aria-current="date"' : ''}><th>${escapeText(name.charAt(0).toUpperCase() + name.slice(1))}</th><td>${text(day)}</td></tr>`;
  }
  return rows;
}

/**
 * The browser copy of siteFieldClockHtml, as source. Plain ES5 without
 * outside references, so it runs as written in every browser.
 */
export const SITE_FIELD_CLOCK_COMPUTE = `function (p, now) {
  var TIME = /^([01]?\\d|2[0-3]):([0-5]\\d)$/;
  var DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
  var MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function esc(value) { return String(value).replace(/[&<>"']/g, function (c) { return MAP[c]; }); }
  function fill(template, name, value) { return String(template).split('{' + name + '}').join(value); }
  var parts = {};
  new Intl.DateTimeFormat('en-GB', { timeZone: p.z, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(now).forEach(function (part) { parts[part.type] = part.value; });
  var year = Number(parts.year), month = Number(parts.month), date = Number(parts.day);
  var minutes = Number(parts.hour) * 60 + Number(parts.minute);
  function valid(value) { return typeof value === 'string' && TIME.test(value) ? (value.length === 4 ? '0' + value : value) : ''; }
  function find(list, test) { for (var i = 0; i < (list || []).length; i++) if (list[i] && test(list[i])) return list[i]; return undefined; }
  function hours(offset) {
    var day = new Date(Date.UTC(year, month - 1, date + offset));
    var iso = day.toISOString().slice(0, 10), index = (day.getUTCDay() + 6) % 7;
    var exception = find(p.x, function (entry) { return entry.date === iso; });
    var source = exception || find(p.d, function (entry) { return entry.day === DAYS[index]; });
    var opens = valid(source && source.opens), closes = valid(source && source.closes);
    return { index: index, closed: !source || source.closed === true || !opens || !closes, opens: opens, closes: closes, note: exception && exception.note ? String(exception.note) : '' };
  }
  function text(day) { return (day.closed ? esc(p.t.closed) : esc(day.opens + '\\u2013' + day.closes)) + (day.note ? ' (' + esc(day.note) + ')' : ''); }
  function toMinutes(value) { return Number(value.slice(0, 2)) * 60 + Number(value.slice(3)); }
  var today = hours(0);
  var open = !today.closed && minutes >= toMinutes(today.opens) && minutes < toMinutes(today.closes);
  var until = esc(fill(p.t.open_until, 'time', today.closes));
  if (p.f === 'opening_hours_today') return text(today);
  if (p.f === 'open_now') return open ? until : esc(p.t.closed);
  if (p.f === 'next_opening') {
    if (open) return until;
    for (var offset = 0; offset < 14; offset++) {
      var day = offset ? hours(offset) : today;
      if (!day.closed && (offset > 0 || minutes < toMinutes(day.opens))) {
        var name = offset === 0 ? p.t.today : offset === 1 ? p.t.tomorrow : String(p.w[day.index] || '');
        return esc(fill(fill(p.t.opens, 'day', name), 'time', day.opens));
      }
    }
    return esc(p.t.closed);
  }
  var rows = '';
  for (var index = 0; index < 7; index++) {
    var weekday = hours(index - today.index), label = String(p.w[index] || '');
    rows += '<tr data-day="' + DAYS[index] + '"' + (index === today.index ? ' data-today="true" aria-current="date"' : '') + '><th>' + esc(label.charAt(0).toUpperCase() + label.slice(1)) + '</th><td>' + text(weekday) + '</td></tr>';
  }
  return rows;
}`;

/** Refreshes date-dependent site fields on load and every minute; ships only with them. */
export const SITE_FIELD_CLOCK_SCRIPT = `(function () {
  var compute = ${SITE_FIELD_CLOCK_COMPUTE};
  function run() {
    var now = new Date(), nodes = document.querySelectorAll('[data-site-field-clock]');
    for (var i = 0; i < nodes.length; i++) {
      try {
        var html = compute(JSON.parse(nodes[i].getAttribute('data-site-field-clock')), now);
        if (nodes[i].innerHTML !== html) nodes[i].innerHTML = html;
      } catch (error) { /* the built value stays */ }
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run); else run();
  setInterval(run, 60000);
})();`;

// ─── Rendering the block ────────────────────────────────────────────────

export interface SiteFieldRenderOptions {
  /** The site's field values (`context.site.fields`). */
  values: unknown;
  definitions?: readonly Pick<SiteFieldGroup, 'fields'>[];
  language?: unknown;
  /** The site's time zone; Europe/Stockholm when unset or unknown. */
  timeZone?: unknown;
  dateFormat?: unknown;
  now?: Date;
  onClockOutput?: (input: SiteFieldClockInput, html: string) => void;
  pageSource?: (config: { ids?: string[] }) => Record<string, unknown>[];
}

export interface PreparedSiteField {
  /** The inner markup; empty when the value is empty and there is no empty text. */
  html: string;
  format: string;
  tag: 'p' | 'span' | 'div';
  empty: boolean;
}

function localeOf(language: unknown): string {
  try { return Intl.getCanonicalLocales(String(language ?? '') || 'en')[0] ?? 'en'; } catch { return 'en'; }
}

export function siteTimeZone(value: unknown): string {
  const zone = typeof value === 'string' ? value.trim() : '';
  if (!zone) return DEFAULT_SITE_TIME_ZONE;
  try { new Intl.DateTimeFormat('en', { timeZone: zone }); return zone; } catch { return DEFAULT_SITE_TIME_ZONE; }
}

/** Weekday names in the page language, Monday first. */
export function weekdayNames(language: unknown): string[] {
  const format = new Intl.DateTimeFormat(localeOf(language), { weekday: 'long', timeZone: 'UTC' });
  // 2024-01-01 was a Monday.
  return WEEKDAYS.map((_, index) => format.format(new Date(Date.UTC(2024, 0, 1 + index))));
}

const isHours = (value: unknown): value is { days?: unknown; exceptions?: unknown } => isRecord(value) && (Array.isArray(value.days) || Array.isArray(value.exceptions));
const isEmpty = (value: unknown) => value === undefined || value === null || value === false
  || (typeof value === 'string' && !value.trim()) || (Array.isArray(value) && !value.length);

function autoFormat(value: unknown, definition: FieldDefinition | undefined): SiteFieldFormat {
  if (definition?.presentation === 'opening_hours' || isHours(value)) return 'opening_hours_week';
  const type = definition?.type;
  if (type === 'richtext') return 'richtext';
  if (type === 'number' || (!type && typeof value === 'number')) return 'number';
  if (type === 'date' || type === 'datetime') return 'date';
  if (Array.isArray(value)) return 'list';
  return 'text';
}

function safeHref(value: string): string {
  const url = value.trim();
  if (!url || /[\u0000- \\]/.test(url)) return '';
  if (url.startsWith('/') && !url.startsWith('//')) return url;
  try {
    const parsed = new URL(url);
    return ['https:', 'http:', 'mailto:', 'tel:'].includes(parsed.protocol) && !parsed.username && !parsed.password ? url : '';
  } catch { return ''; }
}

function optionLabel(definition: FieldDefinition | undefined, value: string): string {
  const index = definition?.options?.indexOf(value) ?? -1;
  return (index >= 0 && definition?.option_labels?.[index]) || value;
}

function textHtml(value: unknown, definition: FieldDefinition | undefined, options: SiteFieldRenderOptions): string {
  if (isRecord(value)) {
    const href = typeof value.href === 'string' ? safeHref(value.href) : typeof value.url === 'string' ? safeHref(value.url) : '';
    const label = String(value.label ?? value.title ?? value.text ?? '').trim();
    return href ? `<a href="${escapeText(href)}">${escapeText(label || href)}</a>` : escapeText(label);
  }
  if (typeof value === 'boolean') return '';
  const text = typeof value === 'number' ? new Intl.NumberFormat(localeOf(options.language)).format(value) : String(value).trim();
  switch (definition?.type) {
    case 'url': {
      const href = safeHref(text);
      return href ? `<a href="${escapeText(href)}">${escapeText(text)}</a>` : escapeText(text);
    }
    case 'email': return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(text) ? `<a href="mailto:${escapeText(text)}">${escapeText(text)}</a>` : escapeText(text);
    case 'image': {
      const src = safeHref(text);
      return src ? `<img src="${escapeText(src)}" alt="" loading="lazy" decoding="async" />` : '';
    }
    case 'page_ref': {
      const page = options.pageSource?.({ ids: [text] })?.[0];
      const href = typeof page?.url === 'string' ? safeHref(page.url) : '';
      const title = String(page?.title ?? '').trim();
      return href && title ? `<a href="${escapeText(href)}">${escapeText(title)}</a>` : '';
    }
    case 'select': return escapeText(optionLabel(definition, text));
    default: return escapeText(text);
  }
}

function itemHtml(item: unknown, definition: FieldDefinition | undefined, options: SiteFieldRenderOptions): string {
  if (isRecord(item)) {
    const parts = (definition?.fields ?? Object.keys(item).map(name => ({ name, type: 'text' }) as FieldDefinition))
      .map(field => (Object.hasOwn(item, field.name) && !isEmpty(item[field.name]) && !isRecord(item[field.name]) && !Array.isArray(item[field.name]) ? textHtml(item[field.name], field, options) : ''))
      .filter(Boolean);
    return parts.join(' – ');
  }
  return definition?.type === 'multiselect' ? escapeText(optionLabel(definition, String(item))) : textHtml(item, undefined, options);
}

/**
 * The markup of a `core/site_field` block for its data: the label and the
 * value in its format. Text is escaped; rich text is inserted as written and
 * cleaned by the renderer's sanitizer with the rest of the page.
 */
export function prepareSiteField(data: Record<string, unknown>, options: SiteFieldRenderOptions): PreparedSiteField {
  const path = siteFieldPath(data.field);
  const definition = siteFieldDefinition(options.definitions, path);
  const value = path.length ? valueAt(options.values, path) : undefined;
  const requested = SITE_FIELD_FORMATS.includes(data.format as SiteFieldFormat) ? data.format as SiteFieldFormat : 'auto';
  const format = requested === 'auto' ? autoFormat(value, definition) : requested;
  const chosenTag = (['p', 'span', 'div'] as const).find(tag => tag === data.tag) ?? 'p';
  const block = ['opening_hours_week', 'list', 'richtext'].includes(format);
  const tag = block ? 'div' : chosenTag;
  const label = String(data.label ?? '').trim();
  const labelHtml = label ? `<span class="block-site-field-label">${escapeText(label)}</span> ` : '';
  const inline = (content: string) => `<span class="block-site-field-value">${content}</span>`;
  const empty = (): PreparedSiteField => {
    const text = String(data.empty_text ?? '').trim();
    return { html: text ? `${labelHtml}${inline(escapeText(text))}` : '', format, tag: chosenTag, empty: true };
  };

  if (SITE_FIELD_CLOCK_FORMATS.has(format)) {
    if (!isHours(value)) return empty();
    const now = options.now ?? new Date();
    const zone = siteTimeZone(options.timeZone);
    // Exceptions from a week back on: this week's rows still show them, older ones never show again.
    const from = new Date(Date.parse(`${localDate(now, zone).date}T00:00:00Z`) - 7 * 86_400_000).toISOString().slice(0, 10);
    const input: SiteFieldClockInput = {
      f: format, z: zone,
      d: (Array.isArray(value.days) ? value.days : []).filter(isRecord).map(day => pick(day, ['day', 'closed', 'opens', 'closes'])),
      x: (Array.isArray(value.exceptions) ? value.exceptions : []).filter(isRecord)
        .filter(day => typeof day.date === 'string' && day.date >= from).map(day => pick(day, ['date', 'closed', 'opens', 'closes', 'note'])),
      w: weekdayNames(options.language), t: openingHoursText(options.language),
    };
    const html = siteFieldClockHtml(input, now);
    options.onClockOutput?.(input, html);
    const clock = `data-site-field-clock="${escapeText(JSON.stringify(input))}"`;
    if (format === 'opening_hours_week') {
      const caption = label ? `<caption class="block-site-field-label">${escapeText(label)}</caption>` : '';
      return { html: `<table class="block-site-field-value block-site-field-hours">${caption}<tbody ${clock}>${html}</tbody></table>`, format, tag, empty: false };
    }
    return { html: `${labelHtml}<span class="block-site-field-value" ${clock}>${html}</span>`, format, tag, empty: false };
  }

  if (isEmpty(value) || isHours(value)) return empty();
  let content = '';
  switch (format) {
    case 'richtext':
      content = typeof value === 'string' ? `<div class="block-site-field-value">${value}</div>` : '';
      break;
    case 'number': {
      const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
      content = Number.isFinite(number) ? inline(escapeText(new Intl.NumberFormat(localeOf(options.language)).format(number))) : '';
      break;
    }
    case 'date':
      content = typeof value === 'string' ? inline(escapeText(formatDisplayDate(value, options.language, options.dateFormat))) : '';
      break;
    case 'list': {
      const items = (Array.isArray(value) ? value : [value]).map(item => itemHtml(item, definition, options)).filter(Boolean);
      content = items.length ? `<ul class="block-site-field-value block-site-field-list">${items.map(item => `<li>${item}</li>`).join('')}</ul>` : '';
      break;
    }
    default: {
      const html = Array.isArray(value) ? value.map(item => itemHtml(item, definition, options)).filter(Boolean).join(', ') : textHtml(value, definition, options);
      content = html ? inline(html) : '';
    }
  }
  if (!content) return empty();
  return { html: `${format === 'richtext' || format === 'list' ? (label ? `<div class="block-site-field-label">${escapeText(label)}</div>` : '') : labelHtml}${content}`, format, tag, empty: false };
}

function pick(value: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) if (value[key] !== undefined && value[key] !== null && value[key] !== '') out[key] = value[key];
  return out;
}

const walkBlocks = (blocks: readonly Block[], visit: (block: Block) => boolean): boolean =>
  blocks.some(block => visit(block) || walkBlocks(block.children ?? [], visit) || (block.slots ?? []).some(slot => walkBlocks(slot, visit)));

/**
 * Whether the blocks show a date-dependent site field, so the page needs the
 * refresh script. With the values, an automatic format resolves; without
 * them it counts as one.
 */
export function usesSiteFieldClock(blocks: readonly Block[], values?: unknown): boolean {
  return walkBlocks(blocks, block => {
    if (block.type !== SITE_FIELD_BLOCK.id) return false;
    const format = String(block.data?.format ?? 'auto');
    if (SITE_FIELD_CLOCK_FORMATS.has(format)) return true;
    if (format !== 'auto' && SITE_FIELD_FORMATS.includes(format as SiteFieldFormat)) return false;
    if (values === undefined) return true;
    // An automatic format shows opening hours as the week.
    const path = siteFieldPath(block.data?.field);
    return path.length > 0 && isHours(valueAt(values, path));
  });
}

/** Names of site fields that `core/site_field` blocks and `site.fields.*` conditions read and no definition declares. */
export function unknownSiteFieldReferences(blocks: readonly Block[], definitions: readonly Pick<SiteFieldGroup, 'fields'>[] | undefined): string[] {
  const unknown = new Set<string>();
  const check = (path: string[]) => { if (path.length && !siteFieldDefinition(definitions, path)) unknown.add(path.join('.')); };
  walkBlocks(blocks, block => {
    if (block.type === SITE_FIELD_BLOCK.id) {
      const path = siteFieldPath(block.data?.field);
      if (path.length) check(path); else unknown.add('');
    }
    if (typeof block.data?.condition === 'string') {
      for (const match of block.data.condition.matchAll(/\bsite\.fields\.([\w.]+)/g)) check(match[1]!.split('.'));
    }
    return false;
  });
  return [...unknown];
}
