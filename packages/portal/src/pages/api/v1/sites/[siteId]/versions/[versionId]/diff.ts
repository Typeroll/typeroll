// GET /api/v1/sites/{siteId}/versions/{versionId}/diff
//
// What a branch changes relative to main: per collection, the ids the branch
// adds, modifies and deletes (tombstones), plus whether it overrides the
// site settings. Same comparison as the portal's branch review and the one
// merge and reset act on. Read-only.

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../../lib/api-auth';
import { getStore } from '../../../../../../../lib/datastore';
import { diffVersion } from '../../../../../../../lib/version-promote';
import { paths, MAIN_VERSION_ID } from '@typeroll/shared';
import type { SiteVersion } from '@typeroll/shared';

export const GET: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const versionId = params.versionId;
  if (!versionId) return apiError('Missing versionId', 400, ctx);
  if (versionId === MAIN_VERSION_ID) return apiError('Main has nothing to diff against itself', 400, ctx);
  const version = await getStore().getDoc<SiteVersion>(paths.version(ctx.orgId, ctx.siteId, versionId));
  if (!version) return apiError('Not found', 404, ctx);
  const diff = await diffVersion(ctx.orgId, ctx.siteId, versionId);
  return apiResponse(ctx, { version_id: versionId, base_version_id: MAIN_VERSION_ID, diff });
};
