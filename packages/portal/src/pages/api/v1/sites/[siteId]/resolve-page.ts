import type { APIRoute } from 'astro';
import { contentPagePath, DEFAULT_CONTENT_TYPE } from '@typeroll/shared';
import { requireApiKey, apiResponse, apiError } from '../../../../../lib/api-auth';
import { vstore } from '../../../../../lib/version-store';
import { publicUrlsFor } from '../../../../../lib/site-public-urls';

const normalizedPath = (path: string) => {
  try { return decodeURI(path).replace(/\/+$/, '') || '/'; } catch { return path; }
};

/** Resolve only stored routes of the selected site. Never fetch a caller's URL. */
export const GET: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const input = new URL(request.url).searchParams.get('url') || '';
  let target: URL;
  const urls = publicUrlsFor(ctx.site);
  const origins = [urls.production, urls.fallback, urls.staging, ctx.site.domain ? `https://${ctx.site.domain}` : null]
    .filter((value): value is string => !!value).map(value => new URL(value).origin);
  try {
    if (!input || input.length > 4096 || input.startsWith('//')) throw new Error();
    target = new URL(input, origins[0] || 'https://selected-site.invalid');
    if (!input.startsWith('/') && !/^https?:\/\//.test(input)) throw new Error();
  } catch { return apiError('Provide an absolute page URL or a path beginning with /.', 400, ctx); }
  if (!input.startsWith('/') && (!origins.includes(target.origin) || target.username || target.password)) {
    return apiError('This URL belongs to a different site. Confirm a site switch and use select_site before searching there.', 409, ctx);
  }
  const [pages, types] = await Promise.all([
    vstore.pages(ctx.orgId, ctx.siteId, ctx.versionId), vstore.contentTypes(ctx.orgId, ctx.siteId, ctx.versionId),
  ]);
  const matches = pages.flatMap(page => {
    const type = types.find(type => type.id === (page.content_type || 'page')) || (page.content_type && page.content_type !== 'page' ? null : DEFAULT_CONTENT_TYPE);
    const path = type ? contentPagePath(page, type) : null;
    return path && normalizedPath(path) === normalizedPath(target.pathname)
      ? [{ id: page.id, title: page.title, path, status: page.status, content_type: page.content_type || 'page' }] : [];
  });
  return apiResponse(ctx, { organization_id: ctx.orgId, site_id: ctx.siteId, version: ctx.versionId,
    pages: matches, fragment: target.hash || null,
    message: matches.length ? undefined : 'No stored page has this route in the selected version. Generated facets or redirects may not have a Page of their own.',
  });
};
