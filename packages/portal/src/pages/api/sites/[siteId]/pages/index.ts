import type { APIRoute } from 'astro';
import { applyTrailingSlash, contentPagePath, DEFAULT_CONTENT_TYPE } from '@typeroll/shared';
import { json, requirePermission, requireSiteAccess } from '../../../../../lib/access';
import { vstore } from '../../../../../lib/version-store';

/** Compact page lookup for internal-link pickers in cookie-authenticated editors. */
export const GET: APIRoute = async ({ request, cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const readCheck = requirePermission(guard.value, 'read');
  if (!readCheck.ok) return readCheck.response;
  const { owner_org_id, site, versionId } = guard.value;
  const [pages, settings, definitions] = await Promise.all([
    vstore.pages(owner_org_id, site.id, versionId),
    vstore.settings(owner_org_id, site.id, versionId),
    vstore.contentTypes(owner_org_id, site.id, versionId),
  ]);
  const types = new Map([[DEFAULT_CONTENT_TYPE.id, DEFAULT_CONTENT_TYPE], ...definitions.map(type => [type.id, type] as const)]);
  const query = new URL(request.url).searchParams;
  const search = (query.get('q') ?? '').toLowerCase();
  const selected = new Set((query.get('ids') ?? '').split(','));
  const trailingSlash = settings?.trailing_slash ?? 'always';
  return json({
    pages: pages
      .map((page) => ({
        id: page.id,
        title: page.title,
        content_type: page.content_type ?? 'page',
        url: types.has(page.content_type ?? 'page') ? (() => {
          const path = contentPagePath(page, types.get(page.content_type ?? 'page')!);
          return path ? applyTrailingSlash(path, trailingSlash) : '';
        })() : '',
        status: page.status,
      }))
      .filter(page => (query.get('include_unrouted') === 'true' || page.url) && (!query.get('content_type') || page.content_type === query.get('content_type')))
      .filter(page => !search || selected.has(page.id) || `${page.title} ${page.url}`.toLowerCase().includes(search))
      .sort((a, b) => Number(selected.has(b.id)) - Number(selected.has(a.id)) || a.title.localeCompare(b.title))
      .slice(0, query.has('q') ? 200 : undefined),
  });
};
