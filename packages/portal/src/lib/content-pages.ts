import { contentPagePath, DEFAULT_CONTENT_TYPE, comparePageValues, pageSort, pageContentValues, type ContentType, type Page, type Site, type SiteVersion } from '@typeroll/shared';
import { pageLiveUrl } from './site-urls';
import { vstore } from './version-store';

export interface ContentPageRow {
  id: string; title: string; path: string; content_type: string; content_type_label: string;
  sort_order?: number | null; live_url: string | null;
  content_mode: string; status: Page['status']; updated_at?: string; editor_path: string; preview_path: string;
}
export async function listContentPages(orgId: string, siteId: string, versionId: string, publication?: { site: Site; version: SiteVersion | null }): Promise<ContentPageRow[]> {
  const [pages, types] = await Promise.all([vstore.pages(orgId, siteId, versionId), vstore.contentTypes(orgId, siteId, versionId)]);
  const byId = new Map<string, ContentType>([[DEFAULT_CONTENT_TYPE.id, DEFAULT_CONTENT_TYPE], ...types.map(type => [type.id, type] as [string, ContentType])]);
  pages.sort((a, b) => {
    const aType = a.content_type ?? 'page', bType = b.content_type ?? 'page';
    return aType.localeCompare(bType) || comparePageValues(pageContentValues(a), pageContentValues(b), pageSort(byId.get(aType)));
  });
  return pages.map(page => {
    const type = byId.get(page.content_type ?? 'page');
    const path = type ? contentPagePath(page, type) : null;
    return { id: page.id, title: page.title, path: path ?? '', content_type: page.content_type ?? 'page',
      content_type_label: type?.label_singular ?? 'Unknown type', content_mode: page.content_mode,
      live_url: publication && path ? pageLiveUrl(publication.site, publication.version, { ...page, path }) : null,
      status: page.status, sort_order: page.sort_order, updated_at: page.date_updated,
      editor_path: `/app/sites/${siteId}/pages/${encodeURIComponent(page.id)}`,
      preview_path: path ? `/api/sites/${siteId}/preview/browse${path}` : '',
    };
  });
}
