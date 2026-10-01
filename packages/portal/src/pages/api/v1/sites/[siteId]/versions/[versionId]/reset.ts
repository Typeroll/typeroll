// POST /api/v1/sites/{siteId}/versions/{versionId}/reset
//
// Discards every override and tombstone on a branch so reads through it pass
// straight through to main again. The branch itself, its deploy address and
// its revision history are kept. Returns the diff that was cleared. Requires
// admin permission on the site, as in the portal.

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../../lib/api-auth';
import { getStore } from '../../../../../../../lib/datastore';
import { resetBranch } from '../../../../../../../lib/version-promote';
import { paths, MAIN_VERSION_ID } from '@typeroll/shared';
import type { SiteVersion } from '@typeroll/shared';

export const POST: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  if (ctx.permission !== 'admin') return apiError('Resetting a branch requires admin permission on the site', 403, ctx);
  const versionId = params.versionId;
  if (!versionId) return apiError('Missing versionId', 400, ctx);
  if (versionId === MAIN_VERSION_ID) return apiError('Main cannot be reset; there is no base above it', 400, ctx);
  const version = await getStore().getDoc<SiteVersion>(paths.version(ctx.orgId, ctx.siteId, versionId));
  if (!version) return apiError('Not found', 404, ctx);
  const cleared = await resetBranch(ctx.orgId, ctx.siteId, versionId);
  return apiResponse(ctx, { ok: true, version_id: versionId, cleared }, 200, { versionId });
};
