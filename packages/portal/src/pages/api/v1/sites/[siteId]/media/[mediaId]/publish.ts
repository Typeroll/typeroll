import type { APIRoute } from 'astro';
import { requireApiKey, apiResponse, apiError } from '../../../../../../../lib/api-auth';
import { connectionFailure } from '../../../../../../../lib/publishing/http';
import { publishMediaFile } from '../../../../../../../lib/media/file-publication';

export const POST: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  if (guard.value.permission === 'read') return apiError('Publishing a PDF requires write permission.', 403);
  if (!params.mediaId) return apiError('Missing mediaId');
  try { return apiResponse(guard.value, await publishMediaFile(guard.value.orgId, guard.value.siteId, params.mediaId)); }
  catch (error) { return connectionFailure(error); }
};
