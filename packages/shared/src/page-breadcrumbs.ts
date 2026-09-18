import type { ContentType, Page } from './types.js';
import { pageContentValues } from './page-content-model.js';
import { facetRoutes } from './taxonomy.js';
import { applyTrailingSlash, type TrailingSlashPolicy } from './url-policy.js';

export interface BreadcrumbItem {
  label: string;
  href: string;
  current?: boolean;
}

function pagePath(page: Pick<Page, 'slug' | 'path'>, trailingSlash: TrailingSlashPolicy): string {
  const raw = page.path || (page.slug === '' || page.slug === 'home' || page.slug === 'index' ? '/' : `/${page.slug}`);
  return applyTrailingSlash(raw, trailingSlash);
}

/** Server-side breadcrumb trail for a standalone page, excluding Home. */
export function pageBreadcrumbs(
  page: Page,
  pages: Page[],
  trailingSlash: TrailingSlashPolicy = 'ignore',
  type?: ContentType,
): BreadcrumbItem[] {
  const byId = new Map(pages.map((candidate) => [candidate.id, candidate]));
  const ancestors: Page[] = [];
  const seen = new Set<string>([page.id]);
  let parentId = page.parent ?? undefined;
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = byId.get(parentId);
    if (!parent) break;
    if (pagePath(parent, trailingSlash) !== '/') ancestors.unshift(parent);
    parentId = parent.parent ?? undefined;
  }
  const inferred: BreadcrumbItem[] = [];
  if (!ancestors.length && !page.parent && type && type.id !== 'page') {
    const token = type.route_template.indexOf('{');
    const prefix = (token < 0 ? '' : type.route_template.slice(0, token)).replace(/\/+$/, '') || '/';
    if (prefix !== '/' && applyTrailingSlash(prefix, trailingSlash) !== pagePath(page, trailingSlash) && pages.some(candidate => candidate.status === 'published' && pagePath(candidate, trailingSlash) === applyTrailingSlash(prefix, trailingSlash))) inferred.push({ label: type.label_plural, href: applyTrailingSlash(prefix, trailingSlash) });
    const siblings = pages.filter(candidate => candidate.content_type === type.id && candidate.status === 'published')
      .map(candidate => ({ ...pageContentValues(candidate), id: candidate.id }));
    const facet = facetRoutes(type, siblings).find(route => route.filters.length === 1 && route.item_ids.includes(page.id));
    if (facet) inferred.push({ label: facet.filters[0].value, href: applyTrailingSlash(facet.path, trailingSlash) });
  }
  return [
    ...inferred,
    ...ancestors.map((ancestor) => ({
      label: ancestor.title,
      href: pagePath(ancestor, trailingSlash),
    })),
    ...(pagePath(page, trailingSlash) === '/' ? [] : [{
      label: page.title,
      href: pagePath(page, trailingSlash),
      current: true,
    }]),
  ];
}
