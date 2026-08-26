// GET /api/sites/{siteId}/export — download the site's full content as a
// zip of fixtures-layout JSON (see lib/export.ts). Admin-only: the export
// contains every draft-free doc including forms and redirects, and it's
// the "take your data and leave" surface — content editors don't need it.

import type { APIRoute } from 'astro';
import { requireSiteAccess, requirePermission } from '../../../../lib/access';
import { buildContentExport } from '../../../../lib/export';

export const GET: APIRoute = async ({ cookies, params }) => {
  const guard = await requireSiteAccess(cookies, params.siteId);
  if (!guard.ok) return guard.response;
  const permCheck = requirePermission(guard.value, 'admin');
  if (!permCheck.ok) return permCheck.response;
  const { site, versionId, owner_org_id } = guard.value;

  const { zip, filename } = await buildContentExport(owner_org_id, site.id, versionId);
  return new Response(new Uint8Array(zip), {
    status: 200,
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  });
};
