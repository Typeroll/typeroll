import type { APIRoute } from 'astro';
import { applyTrailingSlash } from '@typeroll/shared';
import { json, requirePermission, requireSiteAccess } from '../../../../../lib/access';
import { pageUrlFromDoc } from '../../../../../lib/page-paths';
import { vstore } from '../../../../../lib/version-store';

/** Compact page lookup for internal-link pickers in cookie-authenticated editors. */
export const GET: APIRoute = async ({ cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const readCheck = requirePermission(guard.value, 'read');
  if (!readCheck.ok) return readCheck.response;
  const { owner_org_id, site, versionId } = guard.value;
  const [pages, settings] = await Promise.all([
    vstore.pages(owner_org_id, site.id, versionId),
    vstore.settings(owner_org_id, site.id, versionId),
  ]);
  const trailingSlash = settings?.trailing_slash ?? 'always';
  return json({
    pages: pages
      .map((page) => ({
        id: page.id,
        title: page.title,
        url: applyTrailingSlash(pageUrlFromDoc(page), trailingSlash),
        status: page.status,
      }))
      .sort((a, b) => a.url.localeCompare(b.url)),
  });
};
