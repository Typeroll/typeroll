// Item-to-item references, and the backlink index derived from them.
//
// `collection_ref` names a COLLECTION; there was no way to point at an ITEM,
// so "this article mentions these three companies" and "this company's page
// lists articles about it" both had to be hand-maintained. That's exactly the
// internal linking an SEO-driven directory depends on, so it can't be manual.
//
// The forward direction is stored (`item_ref` / `item_ref_list` fields). The
// reverse direction is COMPUTED at render time, never stored — the same
// discipline the URL-inventory analyser uses. Storing both means every write
// has to maintain two documents, and eventually they disagree; and the
// disagreement is invisible because nothing validates it.

import type { CollectionDef, CollectionItem, FieldDefinition } from './types.js';

/** Ref-shaped fields on a collection, with the collection each points at. */
export function refFields(coll: Pick<CollectionDef, 'fields'>): Array<{
  field: FieldDefinition;
  many: boolean;
  target: string;
}> {
  const out: Array<{ field: FieldDefinition; many: boolean; target: string }> = [];
  for (const f of coll.fields ?? []) {
    if (f.type !== 'item_ref' && f.type !== 'item_ref_list') continue;
    if (!f.ref_collection) continue;
    out.push({ field: f, many: f.type === 'item_ref_list', target: f.ref_collection });
  }
  return out;
}

/** Normalise a stored ref value to a list of ids. Tolerates both shapes. */
export function refIds(value: unknown): string[] {
  if (typeof value === 'string') return value ? [value] : [];
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === 'string' && v.length > 0);
  }
  return [];
}

/** One inbound reference: which collection it came from, and which item. */
export interface Backlink {
  /** Collection the REFERENCING item lives in (e.g. 'articles'). */
  collection: string;
  /** Id of the referencing item. */
  id: string;
}

/**
 * `targetCollection → targetItemId → inbound references`
 *
 * Each entry carries its own source collection. Flattening to bare ids was
 * the first shape and it was wrong: an id belongs to whatever collection did
 * the referencing, so a consumer couldn't tell which collection to load it
 * from — and with two referencing collections the list was unusable.
 */
export type BacklinkIndex = Record<string, Record<string, Backlink[]>>;

/**
 * Which items point AT each item, grouped by the collection doing the
 * pointing. `itemsByCollection` is the same published-item map the renderer's
 * collection source already holds, so this adds a pass over data that's
 * loaded either way.
 */
export function buildBacklinkIndex(
  collections: Array<Pick<CollectionDef, 'name' | 'fields'>>,
  itemsByCollection: Record<string, CollectionItem[]>,
): BacklinkIndex {
  const index: BacklinkIndex = {};
  for (const coll of collections) {
    const from = coll.name;
    if (!from) continue;
    const refs = refFields(coll);
    if (refs.length === 0) continue;
    for (const item of itemsByCollection[from] ?? []) {
      if (!item?.id) continue;
      for (const { field, target } of refs) {
        for (const targetId of refIds((item as Record<string, unknown>)[field.name])) {
          // Bucket under the TARGET item, labelled by who is pointing.
          const perTarget = (index[target] ??= {});
          const list = (perTarget[targetId] ??= []);
          // A single article referencing the same company from two fields
          // should appear once in its backlinks, not twice.
          if (!list.some((b) => b.collection === from && b.id === item.id)) {
            list.push({ collection: from, id: item.id });
          }
        }
      }
    }
  }
  return index;
}

/**
 * Inbound references to one item. `fromCollection` narrows to a single
 * referencing collection — which is what a template almost always wants,
 * since it can only render one item-block shape at a time.
 */
export function backlinksFor(
  index: BacklinkIndex,
  collection: string,
  itemId: string,
  fromCollection?: string,
): Backlink[] {
  const all = index[collection]?.[itemId] ?? [];
  return fromCollection ? all.filter((b) => b.collection === fromCollection) : all;
}

/**
 * Expand single `item_ref` fields on a context item so a template can bind
 * `{{item.category.title}}` instead of getting a bare id.
 *
 * Only single refs are expanded — a list would need iteration, which is the
 * repeater's job (`source_type: 'related'`). The original id stays reachable
 * as `{field}_id` so a template that wants the raw value still has it.
 */
export function expandItemRefs(
  item: CollectionItem,
  coll: Pick<CollectionDef, 'fields'>,
  lookup: (collection: string, id: string) => CollectionItem | undefined,
): CollectionItem {
  const refs = refFields(coll).filter((r) => !r.many);
  if (refs.length === 0) return item;
  const out: Record<string, unknown> = { ...(item as Record<string, unknown>) };
  for (const { field, target } of refs) {
    const [id] = refIds(out[field.name]);
    if (!id) continue;
    out[`${field.name}_id`] = id;
    const resolved = lookup(target, id);
    // A ref to a deleted item leaves the raw id in place rather than blanking
    // the field — a stale id is debuggable, a silent empty is not.
    if (resolved) out[field.name] = resolved;
  }
  return out as CollectionItem;
}
