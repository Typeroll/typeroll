import { pageSort, comparePageValues } from './page-options.js';
import type { ContentType, Page } from './types.js';
import { contentPagePath, pageContentValues } from './page-content-model.js';
import { applyTrailingSlash, type TrailingSlashPolicy } from './url-policy.js';

export interface PageLink { id: string; title: string; url: string }
export interface PageNavigation { previous?: PageLink; next?: PageLink }
export function pageNavigation(page: Page, type: ContentType, pages: Page[], trailingSlash: TrailingSlashPolicy = 'ignore'): PageNavigation {
  const siblings = pages.filter(candidate => (candidate.content_type ?? 'page') === type.id
    && (candidate.status === 'published' || candidate.status === 'unlisted') && contentPagePath(candidate, type) !== null);
  siblings.sort((a, b) => comparePageValues(pageContentValues(a), pageContentValues(b), pageSort(type)));
  const i = siblings.findIndex(candidate => candidate.id === page.id);
  if (i < 0) return {};
  const link = (candidate: Page | undefined): PageLink | undefined => candidate ? {
    id: candidate.id, title: candidate.title, url: applyTrailingSlash(contentPagePath(candidate, type)!, trailingSlash),
  } : undefined;
  return { previous: link(siblings[i - 1]), next: link(siblings[i + 1]) };
}
