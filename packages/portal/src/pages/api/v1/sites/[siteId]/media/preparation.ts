import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../lib/api-auth';
import { mediaPreparationStatus, requestMediaPreparation } from '../../../../../../lib/media/preparation';
export const GET: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  return apiResponse(guard.value, await mediaPreparationStatus(guard.value.orgId, guard.value.siteId));
};
export const POST: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  if (guard.value.permission !== 'admin') return apiError('Image preparation requires admin permission.', 403);
  await requestMediaPreparation(guard.value.orgId, guard.value.siteId);
  return apiResponse(guard.value, await mediaPreparationStatus(guard.value.orgId, guard.value.siteId));
};
