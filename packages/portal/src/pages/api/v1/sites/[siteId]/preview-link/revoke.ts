import type { APIRoute } from 'astro';
import { requireApiKey, apiResponse, apiError } from '../../../../../../lib/api-auth';
import { publishingJsonBody, connectionFailure } from '../../../../../../lib/publishing/http';
import { revokePreviewToken } from '../../../../../../lib/preview-signing';

export const POST: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  if (guard.value.permission === 'read') return apiError('Revoking previews requires write permission.', 403);
  try {
    const body = await publishingJsonBody(request);
    return apiResponse(guard.value, await revokePreviewToken(guard.value.orgId, guard.value.siteId, body.token));
  } catch (error) { return connectionFailure(error); }
};
