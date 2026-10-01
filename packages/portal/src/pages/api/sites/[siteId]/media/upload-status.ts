import type { APIRoute } from 'astro';
import { requireSiteAccess, json } from '../../../../../lib/access';
import { mediaUploadStatus } from '../../../../../lib/media/upload-status';

/**
 * Lightweight pre-flight for the media library. Returns whether uploads can
 * actually go through (organization storage connected, or platform R2
 * configured server-side) so the UI can surface a banner instead of leaving
 * the user to discover the failure by trying to upload. The API equivalent is
 * GET /api/v1/sites/{siteId}/media/upload-status.
 */
export const GET: APIRoute = async ({ cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  return json(await mediaUploadStatus(guard.value.owner_org_id, guard.value.site));
};
