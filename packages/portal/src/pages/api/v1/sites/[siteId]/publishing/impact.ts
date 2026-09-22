import type { APIRoute } from 'astro';
import { requireApiKey, apiResponse, apiError } from '../../../../../../lib/api-auth';
import { previewPublicationImpact } from '../../../../../../lib/publishing/impact-preview';

export const GET: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const { orgId, siteId, versionId } = guard.value;
  try { return apiResponse(guard.value, { version_id: versionId, ...await previewPublicationImpact(orgId, siteId, versionId) }); }
  catch { return apiError('Saved content could not be compared with the verified publication. Check content and template validity before deploying.', 409); }
};
