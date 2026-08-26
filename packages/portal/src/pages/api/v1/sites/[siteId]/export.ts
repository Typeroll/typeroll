// GET /api/v1/sites/{siteId}/export — bearer-key content export. Same zip
// as the cookie route (fixtures-layout JSON + manifest, see lib/export.ts);
// this is the path agents and backup scripts use:
//
//   curl -H "Authorization: Bearer $KEY" -o backup.zip \
//     https://<portal>/api/v1/sites/<siteId>/export
//
// admin permission required — a read/write share can consume content
// through the granular endpoints but doesn't get the bulk "take
// everything" surface. Pass ?version=<id> to export a branch snapshot
// (chain-resolved, like a deploy of that branch).

import type { APIRoute } from 'astro';
import { apiError, requireApiKey } from '../../../../../lib/api-auth';
import { buildContentExport } from '../../../../../lib/export';
import { MAIN_VERSION_ID, paths } from '@typeroll/shared';
import { getStore } from '../../../../../lib/datastore';

export const GET: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  if (ctx.permission !== 'admin') return apiError('Insufficient permission (admin required)', 403);

  const url = new URL(request.url);
  let versionId = url.searchParams.get('version') ?? MAIN_VERSION_ID;
  if (versionId !== MAIN_VERSION_ID) {
    const version = await getStore().getDoc(paths.version(ctx.orgId, ctx.siteId, versionId));
    if (!version) return apiError(`Unknown version "${versionId}"`, 404);
  } else {
    versionId = MAIN_VERSION_ID;
  }

  const { zip, filename } = await buildContentExport(ctx.orgId, ctx.siteId, versionId);
  return new Response(new Uint8Array(zip), {
    status: 200,
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  });
};
