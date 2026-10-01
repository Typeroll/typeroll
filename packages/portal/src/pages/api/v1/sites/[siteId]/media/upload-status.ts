// GET /api/v1/sites/{siteId}/media/upload-status
//
// Whether media uploads can go through for this site right now, and why not
// when they can't. Same answer as the portal media library banner
// (lib/media/upload-status.ts). Read access is enough, as in the portal.

import type { APIRoute } from 'astro';
import { apiResponse, requireApiKey } from '../../../../../../lib/api-auth';
import { mediaUploadStatus } from '../../../../../../lib/media/upload-status';

export const GET: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  return apiResponse(ctx, await mediaUploadStatus(ctx.orgId, ctx.site));
};
