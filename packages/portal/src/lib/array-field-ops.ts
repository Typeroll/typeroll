// Pure helpers for editing `array` field values (repeating groups) in the
// inspector: titles, new items, duplicate, move, limits. Browser-safe.

import type { FieldDefinition } from '@typeroll/shared';

export type ArrayItem = Record<string, unknown>;

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

function plainText(value: unknown): string {
  if (typeof value === 'string') return value.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
  if (typeof value === 'number') return String(value);
  if (isRecord(value)) {
    // A link value titles by its address; a page link has no text of its own.
    if (typeof value.url === 'string' && value.url.trim()) return value.url.trim();
    if (typeof value.page_id === 'string' && value.page_id) return 'Page link';
  }
  return '';
}

/**
 * The collapsed title of an item: the value of the field named by
 * `item_label`, else the first text sub-field with a value, else "Item n".
 */
export function arrayItemTitle(field: FieldDefinition, item: unknown, index: number): string {
  const row = isRecord(item) ? item : {};
  const candidates = field.item_label
    ? [field.item_label]
    : (field.fields ?? []).filter(sub => ['text', 'textarea'].includes(sub.type)).map(sub => sub.name);
  for (const name of candidates) {
    const text = plainText(row[name]);
    if (text) return text.length > 60 ? `${text.slice(0, 60)}…` : text;
  }
  return `Item ${index + 1}`;
}

function newKey(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `k_${Math.random().toString(36).slice(2, 12)}`;
}

/** A new item with the sub-fields' defaults (and a fresh stable key when the field has one). */
export function newArrayItem(field: FieldDefinition): ArrayItem {
  const item: ArrayItem = {};
  for (const sub of field.fields ?? []) {
    if (sub.default !== undefined) item[sub.name] = structuredClone(sub.default);
  }
  if (field.item_key) item[field.item_key] = newKey();
  return item;
}

export function moveArrayItem<T>(list: readonly T[], from: number, to: number): T[] {
  if (from === to || from < 0 || from >= list.length) return list.slice();
  const next = list.slice();
  const [moved] = next.splice(from, 1);
  next.splice(Math.max(0, Math.min(to, next.length)), 0, moved!);
  return next;
}

/** Insert a deep copy of item `index` right after it. A stable item key is regenerated. */
export function duplicateArrayItem<T>(list: readonly T[], index: number, field?: FieldDefinition): T[] {
  if (index < 0 || index >= list.length) return list.slice();
  const copy = structuredClone(list[index]) as T;
  if (field?.item_key && isRecord(copy)) (copy as Record<string, unknown>)[field.item_key] = newKey();
  const next = list.slice();
  next.splice(index + 1, 0, copy);
  return next;
}

export function removeArrayItem<T>(list: readonly T[], index: number): T[] {
  return list.filter((_, i) => i !== index);
}

/** What the min_items / max_items limits allow at the current length. */
export function arrayLimits(field: FieldDefinition, length: number): { canAdd: boolean; canRemove: boolean; hint: string | null } {
  const min = field.min_items ?? 0;
  const max = field.max_items;
  const canAdd = max === undefined || length < max;
  const canRemove = length > min;
  const hint = min > 0 && max !== undefined ? `${min}–${max} items`
    : min > 0 ? `At least ${min} ${min === 1 ? 'item' : 'items'}`
    : max !== undefined ? `Up to ${max} ${max === 1 ? 'item' : 'items'}`
    : null;
  return { canAdd, canRemove, hint };
}
