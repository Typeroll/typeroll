import type { ContentType, FieldDefinition, Page } from './types.js';
import { pageContentValues } from './page-content-model.js';

export function refFields(type: Pick<ContentType, 'fields'>): Array<{ field: FieldDefinition; many: boolean; target?: string }> {
  return type.fields.filter(field => field.type === 'page_ref' || field.type === 'page_ref_list')
    .map(field => ({ field, many: field.type === 'page_ref_list', target: field.ref_content_type }));
}

export function refIds(value: unknown): string[] {
  return typeof value === 'string' ? (value ? [value] : [])
    : Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string' && id.length > 0) : [];
}

export interface Backlink { content_type: string; id: string }
/** Page IDs are site-wide. Reverse references are derived, never persisted. */
export type BacklinkIndex = Record<string, Backlink[]>;
export function buildBacklinkIndex(types: Array<Pick<ContentType, 'id' | 'fields'>>, pages: Page[]): BacklinkIndex {
  const index: BacklinkIndex = {};
  const byType = new Map(types.map(type => [type.id, type]));
  for (const page of pages) {
    const type = byType.get(page.content_type ?? 'page');
    if (!type) continue;
    for (const { field } of refFields(type)) {
      for (const id of refIds(page.fields?.[field.name])) {
        const links = index[id] ??= [];
        if (!links.some(link => link.id === page.id)) links.push({ content_type: type.id, id: page.id });
      }
    }
  }
  return index;
}
export function backlinksFor(index: BacklinkIndex, pageId: string, fromType?: string): Backlink[] {
  const links = index[pageId] ?? [];
  return fromType ? links.filter(link => link.content_type === fromType) : links;
}
/** Expand one level only, so circular page references remain bounded. */
export function expandPageRefs(page: Page, type: Pick<ContentType, 'fields'>, lookup: (id: string) => Page | undefined): Record<string, unknown> {
  const values = pageContentValues(page);
  for (const { field, target } of refFields(type).filter(ref => !ref.many)) {
    const [id] = refIds(values[field.name]);
    if (!id) continue;
    values[`${field.name}_id`] = id;
    const resolved = lookup(id);
    if (resolved && (!target || (resolved.content_type ?? 'page') === target)) values[field.name] = pageContentValues(resolved);
  }
  return values;
}
