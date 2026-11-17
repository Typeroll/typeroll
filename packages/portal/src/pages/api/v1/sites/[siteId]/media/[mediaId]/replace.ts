import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../../lib/api-auth';
import { connectionFailure } from '../../../../../../../lib/publishing/http';
import { replaceMedia } from '../../../../../../../lib/media/replacement';
import { validMediaId } from '../../../../../../../lib/media/public-copies';

export const POST: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  if (ctx.permission !== 'admin' || ctx.extensionIdentity) return apiError('Site administrator access is required for a library-wide media replacement.', 403);
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['replacement_media_id', 'dry_run'].includes(key))) return apiError('Expected replacement_media_id and optional dry_run');
  if (!(body.replacement_media_id === null || validMediaId(body.replacement_media_id))) return apiError('replacement_media_id must be a media ID, or null to clear');
  if (body.dry_run !== undefined && typeof body.dry_run !== 'boolean') return apiError('dry_run must be boolean');
  try {
    const result = await replaceMedia(ctx.orgId, ctx.siteId, params.mediaId!, body.replacement_media_id, body.dry_run !== false);
    return apiResponse(ctx, result, 200, body);
  } catch (error) { return connectionFailure(error); }
};
