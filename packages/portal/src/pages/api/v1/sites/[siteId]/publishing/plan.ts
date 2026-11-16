import type { APIRoute } from 'astro';
import { requireApiKey, apiResponse, apiError } from '../../../../../../lib/api-auth';
import { publicationPlan } from '../../../../../../lib/publishing/publication-plan';

/** Read only: what a publication of this version contains, what blocks it, how long it takes and the steps left. */
export const GET: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const { orgId, siteId, versionId } = guard.value;
  try { return apiResponse(guard.value, await publicationPlan(orgId, siteId, versionId)); }
  catch { return apiError('The publication plan could not be prepared. Check publishing setup and content, then try again.', 409); }
};
