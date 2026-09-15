import { contentPagePath, DEFAULT_CONTENT_TYPE, pageContentValues, publicContentPage } from './page-content-model.js';
import type { ContentType, Page } from './types.js';
import { pageSort, comparePageValues } from './page-options.js';
import { expandPageRefs } from './page-refs.js';
export interface PageSourceConfig {
  content_type?: string;
  ids?: string[];
  limit?: number;
  sort_by?: string;
  sort_order?: 'asc' | 'desc';
  filter_field?: string;
  filter_value?: string;
  pinned_ids?: string[];
  exclude_id?: string;
}
export function createPageSource(types: ContentType[], pages: Page[]): (config: PageSourceConfig) => Record<string, unknown>[] {
  const byType = new Map([[DEFAULT_CONTENT_TYPE.id, DEFAULT_CONTENT_TYPE], ...types.map(type => [type.id, type] as const)]);
  const publicPages = pages.filter(page => page.status === 'published' && byType.has(page.content_type ?? 'page'))
    .map(page => publicContentPage(page, byType.get(page.content_type ?? 'page')!));
  const publicById = new Map(publicPages.map(page => [page.id, page]));
  const rawValues = new Map(publicPages.map(page => [page.id, pageContentValues(page)]));
  const values: Array<Record<string, unknown> & { id: string; content_type: string; url: string }> = publicPages.map(page => ({
    ...expandPageRefs(page, byType.get(page.content_type ?? 'page')!, id => publicById.get(id)),
    id: page.id, content_type: page.content_type ?? 'page',
    url: contentPagePath(page, byType.get(page.content_type ?? 'page')!) ?? '',
  }));
  const byId = new Map(values.map(page => [page.id, page]));
  return config => {
    let result = config.ids ? config.ids.flatMap(id => byId.has(id) ? [byId.get(id)!] : []) : values.slice();
    result = result.filter(page => (!config.content_type || page.content_type === config.content_type) && page.id !== config.exclude_id);
    if (config.filter_field && config.filter_value !== undefined) {
      const field = config.filter_field, expected = config.filter_value;
      result = result.filter(page => {
        const value = rawValues.get(page.id)?.[field];
        return Array.isArray(value) ? value.some(entry => String(entry) === expected) : String(value ?? '') === expected;
      });
    }
    if (!config.ids) {
      const sort = pageSort(config.content_type ? byType.get(config.content_type) : undefined, config);
      result.sort((a, b) => comparePageValues(a, b, sort));
    }
    if (config.pinned_ids?.length) {
      const rank = new Map(config.pinned_ids.map((id, i) => [id, i]));
      result.sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity));
    }
    return config.limit && config.limit > 0 ? result.slice(0, config.limit) : result;
  };
}
