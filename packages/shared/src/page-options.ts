import type { ContentType, PageTemplate } from './types.js';

/** Templates describe presentation independently of a Page's field schema. */
export function templateMatchesContentType(template: PageTemplate, contentType: string): boolean {
  return !template.applies_to || template.applies_to === 'any' || template.applies_to === 'page'
    || template.applies_to === `content_type:${contentType}`;
}
export function contentTypeAllowsTemplate(type: ContentType, template: PageTemplate): boolean {
  return templateMatchesContentType(template, type.id)
    && (!Array.isArray(type.allowed_templates) || type.allowed_templates.includes(template.id));
}
export function pageSort(type?: ContentType, override: { sort_by?: string; sort_order?: 'asc' | 'desc' } = {}) {
  const field = override.sort_by || type?.sort_field || 'sort_order';
  const direction = override.sort_order || (override.sort_by ? 'asc' : type?.sort_dir) || 'asc';
  return { field, direction };
}
/** Missing values sort last; the stable Page ID breaks ties across builds. */
export function comparePageValues(a: Record<string, unknown>, b: Record<string, unknown>, sort: ReturnType<typeof pageSort>): number {
  const left = a[sort.field], right = b[sort.field];
  const missingLeft = left == null || left === '', missingRight = right == null || right === '';
  if (missingLeft !== missingRight) return missingLeft ? 1 : -1;
  const compared = typeof left === 'number' && typeof right === 'number'
    ? left - right : String(left ?? '').localeCompare(String(right ?? ''), 'en', { numeric: true });
  return (compared * (sort.direction === 'desc' ? -1 : 1)) || String(a.id).localeCompare(String(b.id), 'en');
}
