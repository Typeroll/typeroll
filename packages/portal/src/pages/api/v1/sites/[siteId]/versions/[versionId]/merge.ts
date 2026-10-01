// POST /api/v1/sites/{siteId}/versions/{versionId}/merge
//
// Merges (promotes) a branch's overrides and tombstones onto main. The
// branch is left in place; the customer can keep iterating on it or delete
// it through DELETE /versions/{versionId}.

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../../lib/api-auth';
import { promoteBranch } from '../../../../../../../lib/version-promote';
import { MAIN_VERSION_ID } from '@typeroll/shared';

export const POST: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  // Same rule as the portal's promote action: merging onto main is a site
  // administration action, not an ordinary content write.
  if (ctx.permission !== 'admin') return apiError('Merging a branch requires admin permission on the site', 403, ctx);
  const versionId = params.versionId;
  if (!versionId) return apiError('Missing versionId');
  if (versionId === MAIN_VERSION_ID) {
    return apiError('Main cannot be merged onto itself', 400);
  }
  const applied = await promoteBranch(
    ctx.orgId, ctx.siteId, versionId, MAIN_VERSION_ID,
    `api-key:${ctx.keyPrefix}`,
  );
  return apiResponse(ctx, { ok: true, applied }, 200, { versionId });
};
