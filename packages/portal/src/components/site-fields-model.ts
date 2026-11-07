// Pure helpers behind the portal's site fields page: editing the settings
// pages' definitions, mapping validator error paths to the controls they
// belong to, the opening-hours row model, and the request bodies. The
// component in SiteFieldsEditor.tsx only wires these to React state.

import {
  MAX_SITE_FIELDS, MAX_SITE_FIELD_GROUPS, SITE_FIELD_TYPES, WEEKDAYS, openingHoursField,
  type FieldDefinition, type FieldType, type OpeningHours, type SiteFieldError, type SiteFieldGroup, type Weekday,
} from '@typeroll/shared';
import { suggestFieldName } from '../lib/block-type-builder';

/** Index path to a field: its index in the group, then in each nested `fields`. */
export type FieldPath = number[];

export const FIELD_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
export const GROUP_ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
/** Lists and groups nest at most three levels (the shared validator's limit). */
export const MAX_SITE_FIELD_DEPTH = 3;

export const SITE_FIELD_TYPE_LABELS: Record<string, string> = {
  text: 'Text', textarea: 'Long text', richtext: 'Formatted text', boolean: 'Checkbox (yes / no)', number: 'Number',
  select: 'Choice', multiselect: 'Multiple choice', date: 'Date', datetime: 'Date and time', image: 'Image',
  url: 'Web address', email: 'Email address', page_ref: 'Page', array: 'List of items', object: 'Group of fields',
};

export const WEEKDAY_LABELS: Record<Weekday, string> = {
  monday: 'Monday', tuesday: 'Tuesday', wednesday: 'Wednesday', thursday: 'Thursday',
  friday: 'Friday', saturday: 'Saturday', sunday: 'Sunday',
};

export const isOpeningHours = (field: FieldDefinition) => field.presentation === 'opening_hours' && field.type === 'object';

// ─── Names and ids ──────────────────────────────────────────────────────

/** Every top-level field name of the site: names are unique across settings pages. */
export function siteFieldNames(groups: SiteFieldGroup[]): string[] {
  return groups.flatMap((group) => group.fields.map((field) => field.name));
}

/** A settings page id from its title, unique among `taken`. */
export function suggestGroupId(label: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  let base = label.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  if (!base || !/^[a-z]/.test(base)) base = `settings${base ? `-${base}` : ''}`;
  let id = base;
  for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
  return id;
}

/** Why a field name cannot be used, or null. `taken` are the other names it must not repeat. */
export function fieldNameProblem(name: string, taken: Iterable<string>): string | null {
  if (!name) return 'Give the field a name';
  if (!FIELD_NAME_PATTERN.test(name)) return 'Use lowercase letters, digits and underscores, starting with a letter';
  if (new Set(taken).has(name)) return `The field name ${name} is already used on this site`;
  return null;
}

export function groupIdProblem(id: string, taken: Iterable<string>): string | null {
  if (!GROUP_ID_PATTERN.test(id)) return 'Use lowercase letters, digits, - and _, starting with a letter';
  if (new Set(taken).has(id)) return 'Settings page ids must be unique';
  return null;
}

// ─── Settings pages ─────────────────────────────────────────────────────

export function canAddGroup(groups: SiteFieldGroup[]): boolean {
  return groups.length < MAX_SITE_FIELD_GROUPS;
}

export function addGroup(groups: SiteFieldGroup[], label = 'Settings'): SiteFieldGroup[] {
  if (!canAddGroup(groups)) return groups;
  return [...groups, { id: suggestGroupId(label, groups.map((group) => group.id)), label, access: 'editor', fields: [] }];
}

export function updateGroup(groups: SiteFieldGroup[], index: number, patch: Partial<Omit<SiteFieldGroup, 'fields'>>): SiteFieldGroup[] {
  return groups.map((group, i) => {
    if (i !== index) return group;
    const next = { ...group, ...patch };
    if (patch.description !== undefined && !patch.description.trim()) delete next.description;
    return next;
  });
}

export function removeGroup(groups: SiteFieldGroup[], index: number): SiteFieldGroup[] {
  return groups.filter((_, i) => i !== index);
}

export function moveInList<T>(list: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return list;
  const next = list.slice();
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item!);
  return next;
}

// ─── Fields inside a settings page ──────────────────────────────────────

/** The field at `path`, or undefined. */
export function fieldAt(fields: FieldDefinition[], path: FieldPath): FieldDefinition | undefined {
  let list = fields;
  let found: FieldDefinition | undefined;
  for (const index of path) {
    found = list[index];
    if (!found) return undefined;
    list = found.fields ?? [];
  }
  return found;
}

/** The sibling list holding `path`'s field (the list at `parent`). */
export function siblingsAt(fields: FieldDefinition[], parent: FieldPath): FieldDefinition[] {
  return parent.length ? fieldAt(fields, parent)?.fields ?? [] : fields;
}

/** Replace the list at `parent` (the top level when empty). */
function withList(fields: FieldDefinition[], parent: FieldPath, change: (list: FieldDefinition[]) => FieldDefinition[]): FieldDefinition[] {
  if (!parent.length) return change(fields);
  const [head, ...rest] = parent;
  return fields.map((field, i) => (i === head ? { ...field, fields: withList(field.fields ?? [], rest, change) } : field));
}

/** Merge `patch` into the field at `path`; `undefined` and empty optional strings remove a property. */
export function updateFieldAt(fields: FieldDefinition[], path: FieldPath, patch: Partial<FieldDefinition>): FieldDefinition[] {
  const parent = path.slice(0, -1);
  const index = path[path.length - 1]!;
  return withList(fields, parent, (list) => list.map((field, i) => {
    if (i !== index) return field;
    const next = { ...field, ...patch } as Record<string, unknown>;
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined || (value === '' && key !== 'name' && key !== 'label')) delete next[key];
    }
    return next as unknown as FieldDefinition;
  }));
}

export function removeFieldAt(fields: FieldDefinition[], path: FieldPath): FieldDefinition[] {
  const index = path[path.length - 1]!;
  return withList(fields, path.slice(0, -1), (list) => list.filter((_, i) => i !== index));
}

export function moveFieldAt(fields: FieldDefinition[], path: FieldPath, delta: -1 | 1): FieldDefinition[] {
  const index = path[path.length - 1]!;
  return withList(fields, path.slice(0, -1), (list) => moveInList(list, index, index + delta));
}

export function canMoveField(fields: FieldDefinition[], path: FieldPath, delta: -1 | 1): boolean {
  const index = path[path.length - 1]! + delta;
  return index >= 0 && index < siblingsAt(fields, path.slice(0, -1)).length;
}

/**
 * Open-state keys after the list at `parent` of group `groupIndex` changed:
 * `map` gives each old index its new one, or null when the field is gone.
 * Keys of nested fields follow their parent.
 */
export function reindexKeys(keys: Set<string>, groupIndex: number, parent: FieldPath, map: (index: number) => number | null): Set<string> {
  const next = new Set<string>();
  for (const key of keys) {
    const [group, rest] = key.split(':');
    const path = rest ? rest.split('.').map(Number) : [];
    const inList = Number(group) === groupIndex && path.length > parent.length && parent.every((index, i) => path[i] === index);
    if (!inList) { next.add(key); continue; }
    const moved = map(path[parent.length]!);
    if (moved === null) continue;
    path[parent.length] = moved;
    next.add(definitionKey(groupIndex, path));
  }
  return next;
}

/** Choice options as editable lines: `value` or `value | Label`. */
export function optionsToText(field: Pick<FieldDefinition, 'options' | 'option_labels'>): string {
  return (field.options ?? []).map((option, index) => {
    const label = field.option_labels?.[index];
    return label && label !== option ? `${option} | ${label}` : option;
  }).join('\n');
}

export function optionsFromText(text: string): { options: string[]; labels: string[] | undefined } {
  const rows = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const at = line.indexOf('|');
    const value = (at >= 0 ? line.slice(0, at) : line).trim();
    const label = at >= 0 ? line.slice(at + 1).trim() : '';
    return { value, label: label || value };
  }).filter((row) => row.value);
  const options = rows.map((row) => row.value);
  return { options, labels: rows.some((row) => row.label !== row.value) ? rows.map((row) => row.label) : undefined };
}

/** Count of fields in every settings page, nested ones included. */
export function countSiteFields(groups: SiteFieldGroup[]): number {
  return siteFieldNames(groups).length;
}

export function canAddField(groups: SiteFieldGroup[], parent: FieldPath): boolean {
  return parent.length > 0 || countSiteFields(groups) < MAX_SITE_FIELDS;
}

/**
 * Add a new text field to the list at `parent` of group `groupIndex`. Its
 * name is unique site-wide at the top level and within its list when nested.
 * Returns the new groups and the new field's path.
 */
export function addFieldTo(groups: SiteFieldGroup[], groupIndex: number, parent: FieldPath, field?: Partial<FieldDefinition>): { groups: SiteFieldGroup[]; path: FieldPath } {
  const group = groups[groupIndex]!;
  const list = siblingsAt(group.fields, parent);
  const taken = parent.length ? list.map((other) => other.name) : siteFieldNames(groups);
  const label = field?.label ?? 'New field';
  const name = field?.name && !taken.includes(field.name) ? field.name : suggestFieldName(field?.name ?? label, taken);
  const created = { type: 'text' as FieldType, ...field, label, name } as FieldDefinition;
  const fields = withList(group.fields, parent, (current) => [...current, created]);
  return { groups: groups.map((g, i) => (i === groupIndex ? { ...g, fields } : g)), path: [...parent, list.length] };
}

/** Insert a ready opening-hours field (week plus exceptions) at the end of the group. */
export function addOpeningHours(groups: SiteFieldGroup[], groupIndex: number): { groups: SiteFieldGroup[]; path: FieldPath } {
  const taken = siteFieldNames(groups);
  const name = suggestFieldName('opening_hours', taken);
  const field = openingHoursField(name, taken.includes('opening_hours') ? `Opening hours ${name.replace(/^opening_hours_/, '')}` : 'Opening hours');
  const group = groups[groupIndex]!;
  return {
    groups: groups.map((g, i) => (i === groupIndex ? { ...g, fields: [...g.fields, field] } : g)),
    path: [group.fields.length],
  };
}

/** The patch that changes a field's type, dropping settings the new type has no use for. */
export function typeChange(field: FieldDefinition, type: FieldType): Partial<FieldDefinition> {
  const patch: Partial<FieldDefinition> = { type, default: undefined, presentation: undefined };
  const choice = type === 'select' || type === 'multiselect';
  if (choice && !field.options?.length) patch.options = ['option_1', 'option_2'];
  if (!choice) { patch.options = undefined; patch.option_labels = undefined; }
  if (type === 'array' || type === 'object') { if (!field.fields?.length) patch.fields = [{ name: 'title', type: 'text', label: 'Title' }]; }
  else patch.fields = undefined;
  if (type !== 'array') { patch.item_label = undefined; patch.min_items = undefined; patch.max_items = undefined; }
  if (type !== 'number') { patch.min = undefined; patch.max = undefined; }
  if (!['text', 'textarea', 'url', 'email', 'number'].includes(type)) patch.placeholder = undefined;
  return patch;
}

/** Types a field at `depth` (1 = top level) may take. */
export function typesAtDepth(depth: number): FieldType[] {
  return SITE_FIELD_TYPES.filter((type) => depth < MAX_SITE_FIELD_DEPTH || (type !== 'array' && type !== 'object'));
}

/**
 * Top-level fields that exist in `before` but not in `after` (removed or
 * renamed) and hold a value: saving the definitions deletes those values.
 */
export function valuesLostBySave(before: SiteFieldGroup[], after: SiteFieldGroup[], values: Record<string, unknown>): Array<{ name: string; label: string }> {
  const kept = new Set(siteFieldNames(after));
  return before.flatMap((group) => group.fields)
    .filter((field) => !kept.has(field.name) && hasValue(values[field.name]))
    .map((field) => ({ name: field.name, label: field.label }));
}

export function hasValue(value: unknown): boolean {
  if (value === undefined || value === null || value === '') return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.values(value as Record<string, unknown>).some(hasValue);
  return true;
}

// ─── Error paths ────────────────────────────────────────────────────────

/** `groups[0].fields[1].fields[2].name` → segments `['groups', 0, 'fields', 1, 'fields', 2, 'name']`. */
export function parseErrorPath(path: string): Array<string | number> {
  const out: Array<string | number> = [];
  for (const match of path.matchAll(/([^.[\]]+)|\[(\d+)\]/g)) out.push(match[2] !== undefined ? Number(match[2]) : match[1]!);
  return out;
}

export interface DefinitionProblem { property: string; message: string }
export interface DefinitionErrors {
  /** Messages about the whole set of settings pages (limits). */
  general: string[];
  /** Key `group` or `group:path` (`0`, `0:1`, `0:1.2`) → problems. */
  byKey: Map<string, DefinitionProblem[]>;
}

export const definitionKey = (groupIndex: number, path: FieldPath = []) => (path.length ? `${groupIndex}:${path.join('.')}` : String(groupIndex));

/** Sort the PUT validator's errors onto the settings page or field they name. */
export function mapDefinitionErrors(errors: SiteFieldError[]): DefinitionErrors {
  const general: string[] = [];
  const byKey = new Map<string, DefinitionProblem[]>();
  for (const error of errors) {
    const segments = parseErrorPath(error.path);
    if (segments[0] !== 'groups' || typeof segments[1] !== 'number') { general.push(error.message); continue; }
    const groupIndex = segments[1];
    const path: FieldPath = [];
    let i = 2;
    while (segments[i] === 'fields' && typeof segments[i + 1] === 'number') { path.push(segments[i + 1] as number); i += 2; }
    const property = segments.slice(i).map(String).join('.');
    const key = definitionKey(groupIndex, path);
    byKey.set(key, [...(byKey.get(key) ?? []), { property, message: error.message }]);
  }
  return { general, byKey };
}

/** Does any problem sit in group `groupIndex` or one of its fields? */
export function groupHasDefinitionErrors(errors: DefinitionErrors, groupIndex: number): boolean {
  const prefix = `${groupIndex}:`;
  return [...errors.byKey.keys()].some((key) => key === String(groupIndex) || key.startsWith(prefix));
}

export interface ValueProblem {
  /** The path below the top-level field, e.g. `days[0].opens`; empty for the field itself. */
  path: string;
  message: string;
}

/** Sort the PATCH validator's errors by the top-level field they belong to (`''` when none). */
export function mapValueErrors(errors: SiteFieldError[]): Map<string, ValueProblem[]> {
  const out = new Map<string, ValueProblem[]>();
  for (const error of errors) {
    const match = /^([a-z][a-z0-9_]*)(.*)$/.exec(error.path);
    const name = match && error.path !== 'values' ? match[1]! : '';
    const rest = match ? match[2]!.replace(/^\./, '') : '';
    out.set(name, [...(out.get(name) ?? []), { path: name ? rest : error.path, message: error.message }]);
  }
  return out;
}

/** The problems below `prefix` (e.g. `days[2]`), with paths relative to it. */
export function problemsUnder(problems: ValueProblem[], prefix: string): ValueProblem[] {
  return problems.flatMap((problem) => {
    if (problem.path === prefix) return [{ path: '', message: problem.message }];
    if (problem.path.startsWith(`${prefix}.`)) return [{ path: problem.path.slice(prefix.length + 1), message: problem.message }];
    if (problem.path.startsWith(`${prefix}[`)) return [{ path: problem.path.slice(prefix.length), message: problem.message }];
    return [];
  });
}

/** A readable location for a nested problem: `Week › item 1 › Opens`. */
export function describeProblemPath(field: FieldDefinition, path: string): string {
  const parts: string[] = [];
  let current: FieldDefinition | undefined = field;
  for (const segment of parseErrorPath(path)) {
    if (typeof segment === 'number') { parts.push(`item ${segment + 1}`); continue; }
    current = current?.fields?.find((child) => child.name === segment);
    parts.push(current?.label ?? segment);
  }
  return parts.join(' › ');
}

// ─── Values ─────────────────────────────────────────────────────────────

/** The values of a settings page's fields, from all of the site's values. */
export function groupValues(group: SiteFieldGroup, values: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of group.fields) if (values[field.name] !== undefined) out[field.name] = values[field.name];
  return out;
}

const emptyToNull = (value: unknown) => (value === undefined || value === '' || (Array.isArray(value) && value.length === 0) ? null : value);

/**
 * The body of a PATCH that saves one settings page: each of its fields, an
 * emptied one as `null` so the stored value is cleared.
 */
export function valuesPatchBody(group: SiteFieldGroup, draft: Record<string, unknown>, expectedUpdatedAt: string | undefined): { values: Record<string, unknown>; expected_updated_at?: string } {
  const values: Record<string, unknown> = {};
  for (const field of group.fields) values[field.name] = emptyToNull(draft[field.name]);
  return { values, ...(expectedUpdatedAt ? { expected_updated_at: expectedUpdatedAt } : {}) };
}

export function definitionsPutBody(groups: SiteFieldGroup[], expectedUpdatedAt: string | undefined): { groups: SiteFieldGroup[]; expected_updated_at?: string } {
  return {
    groups: groups.map(({ description, ...group }) => ({ ...group, label: group.label.trim(), ...(description?.trim() ? { description: description.trim() } : {}) })),
    ...(expectedUpdatedAt ? { expected_updated_at: expectedUpdatedAt } : {}),
  };
}

/** Whether the person may change this settings page's values. */
export function canEditGroup(group: SiteFieldGroup, permission: 'read' | 'write' | 'admin'): boolean {
  if (permission === 'read') return false;
  return group.access !== 'admin' || permission === 'admin';
}

/** A short text of a stored value for read-only display. */
export function describeValue(field: FieldDefinition, value: unknown): string {
  if (!hasValue(value)) return '—';
  switch (field.type) {
    case 'boolean': return value ? 'Yes' : 'No';
    case 'select': {
      const index = field.options?.indexOf(String(value)) ?? -1;
      return index >= 0 ? field.option_labels?.[index] ?? String(value) : String(value);
    }
    case 'multiselect': return Array.isArray(value) ? value.map((item) => describeValue({ ...field, type: 'select' }, item)).join(', ') : String(value);
    case 'richtext': return String(value).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    case 'array': { const n = Array.isArray(value) ? value.length : 0; return `${n} ${n === 1 ? 'item' : 'items'}`; }
    case 'object': return (field.fields ?? []).filter((child) => hasValue((value as Record<string, unknown>)[child.name]))
      .map((child) => `${child.label}: ${describeValue(child, (value as Record<string, unknown>)[child.name])}`).join('; ') || '—';
    default: return String(value);
  }
}

/** How a template uses a site field. */
export function fieldUsage(field: FieldDefinition): { placeholder: string; condition?: string; hint: string } {
  const placeholder = `{{site.fields.${field.name}}}`;
  if (isOpeningHours(field)) {
    return { placeholder, hint: `Add a Site field block, choose “${field.label}” and pick how to show it: the week, today or open now.` };
  }
  if (field.type === 'boolean') {
    return { placeholder, condition: `site.fields.${field.name}`, hint: 'Show or hide a block with the condition, or add a Site field block.' };
  }
  if (field.type === 'array' || field.type === 'object') {
    return { placeholder, hint: `Add a Site field block, or reach a part with {{site.fields.${field.name}.<name>}}.` };
  }
  return { placeholder, hint: 'Type it into any text, or add a Site field block to show the value.' };
}

// ─── Opening hours ──────────────────────────────────────────────────────

export interface DayRow { day: Weekday; closed: boolean; opens: string; closes: string }
export interface ExceptionRow { date: string; closed: boolean; opens: string; closes: string; note: string }

/** Seven rows, Monday first, whatever the stored value holds. */
export function openingHoursRows(value: unknown): DayRow[] {
  const hours = (value && typeof value === 'object' && !Array.isArray(value) ? value : {}) as OpeningHours;
  return WEEKDAYS.map((day) => {
    const stored = hours.days?.find((entry) => entry?.day === day);
    return { day, closed: stored?.closed === true, opens: stored?.opens ?? '', closes: stored?.closes ?? '' };
  });
}

export function exceptionRows(value: unknown): ExceptionRow[] {
  const hours = (value && typeof value === 'object' && !Array.isArray(value) ? value : {}) as OpeningHours;
  return (hours.exceptions ?? []).map((entry) => ({
    date: entry?.date ?? '', closed: entry?.closed === true, opens: entry?.opens ?? '', closes: entry?.closes ?? '', note: entry?.note ?? '',
  }));
}

/** The stored value for rows: closed days keep no times, empty strings are left out. */
export function openingHoursValue(days: DayRow[], exceptions: ExceptionRow[]): OpeningHours {
  const times = (row: { closed: boolean; opens: string; closes: string }) => (row.closed ? {} : {
    ...(row.opens.trim() ? { opens: row.opens.trim() } : {}), ...(row.closes.trim() ? { closes: row.closes.trim() } : {}),
  });
  return {
    days: days.map((row) => ({ day: row.day, closed: row.closed, ...times(row) })),
    exceptions: exceptions.map((row) => ({
      date: row.date, closed: row.closed, ...times(row), ...(row.note.trim() ? { note: row.note.trim() } : {}),
    })),
  };
}

export function setDay(value: unknown, day: Weekday, patch: Partial<Omit<DayRow, 'day'>>): OpeningHours {
  return openingHoursValue(openingHoursRows(value).map((row) => (row.day === day ? { ...row, ...patch } : row)), exceptionRows(value));
}

/** Give `targets` the hours of `from` (e.g. Monday to every weekday). */
export function copyDay(value: unknown, from: Weekday, targets: readonly Weekday[]): OpeningHours {
  const rows = openingHoursRows(value);
  const source = rows.find((row) => row.day === from)!;
  return openingHoursValue(rows.map((row) => (targets.includes(row.day) ? { ...source, day: row.day } : row)), exceptionRows(value));
}

export const MAX_EXCEPTIONS = 60;

export function addException(value: unknown, date = ''): OpeningHours {
  const exceptions = exceptionRows(value);
  if (exceptions.length >= MAX_EXCEPTIONS) return openingHoursValue(openingHoursRows(value), exceptions);
  return openingHoursValue(openingHoursRows(value), [...exceptions, { date, closed: true, opens: '', closes: '', note: '' }]);
}

export function updateException(value: unknown, index: number, patch: Partial<ExceptionRow>): OpeningHours {
  return openingHoursValue(openingHoursRows(value), exceptionRows(value).map((row, i) => (i === index ? { ...row, ...patch } : row)));
}

export function removeException(value: unknown, index: number): OpeningHours {
  return openingHoursValue(openingHoursRows(value), exceptionRows(value).filter((_, i) => i !== index));
}

const TIME = /^([01]?\d|2[0-3]):([0-5]\d)$/;

/** A problem with a row's times the editor can point out before saving. */
export function timeProblem(row: { closed: boolean; opens: string; closes: string }): string | null {
  if (row.closed) return null;
  const opens = row.opens.trim(), closes = row.closes.trim();
  if (!opens && !closes) return null;
  if (!opens || !closes) return 'Give both an opening and a closing time, or mark it closed';
  if (!TIME.test(opens) || !TIME.test(closes)) return 'Use 24-hour times like 09:00';
  const minutes = (time: string) => Number(time.split(':')[0]) * 60 + Number(time.split(':')[1]);
  if (minutes(closes) <= minutes(opens)) return 'The closing time is before the opening time';
  return null;
}

