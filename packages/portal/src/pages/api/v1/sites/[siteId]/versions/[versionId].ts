// GET    /api/v1/sites/{siteId}/versions/{versionId}
// DELETE /api/v1/sites/{siteId}/versions/{versionId}     discard a branch
//
// Deleting main is refused — it's the canonical history. Deleting a branch
// removes the SiteVersion doc and the per-branch overrides + tombstones;
// any docs that branched-overrode will fall back to main automatically.

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../lib/api-auth';
import { getStore } from '../../../../../../lib/datastore';
import { paths, MAIN_VERSION_ID } from '@typeroll/shared';
import type { SiteVersion } from '@typeroll/shared';

export const GET: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const versionId = params.versionId;
  if (!versionId) return apiError('Missing versionId');
  if (versionId === MAIN_VERSION_ID) {
    return apiResponse(ctx, {
      version: {
        id: MAIN_VERSION_ID, name: 'Main', kind: 'main',
        created_at: ctx.site.created_at ?? new Date().toISOString(),
        robots_blocked: false,
      },
    });
  }
  const doc = await getStore().getDoc<SiteVersion>(paths.version(ctx.orgId, ctx.siteId, versionId));
  if (!doc) return apiError('Not found', 404);
  return apiResponse(ctx, { version: doc });
};

export const DELETE: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const versionId = params.versionId;
  if (!versionId) return apiError('Missing versionId');
  if (versionId === MAIN_VERSION_ID) {
    return apiError('main cannot be deleted', 400);
  }
  const doc = await getStore().getDoc<SiteVersion>(paths.version(ctx.orgId, ctx.siteId, versionId));
  if (!doc) return apiError('Not found', 404);
  await getStore().deleteDoc(paths.version(ctx.orgId, ctx.siteId, versionId));
  return apiResponse(ctx, { ok: true });
};
