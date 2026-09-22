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
import { apiError, requireApiKey, withApiIdentity } from '../../../../../lib/api-auth';
import { buildContentExport } from '../../../../../lib/export';

export const GET: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  if (ctx.permission !== 'admin') return apiError('Insufficient permission (admin required)', 403);

  // ?version=<id> is already resolved — and an unknown one already refused —
  // by requireApiKey.
  const { zip, filename } = await buildContentExport(ctx.orgId, ctx.siteId, ctx.versionId);
  // An export is the one response someone files away and reads back later,
  // out of context, so naming the site it came from matters most here.
  return withApiIdentity(ctx, new Response(new Uint8Array(zip), {
    status: 200,
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  }));
};
