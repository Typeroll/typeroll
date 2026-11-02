import type { APIRoute } from 'astro';
import { requireApiKey, apiResponse, apiError } from '../../../../../../lib/api-auth';
import { previewPublicationImpact } from '../../../../../../lib/publishing/impact-preview';
import { publicationTargets } from '../../../../../../lib/publishing/publication-targets';

export const GET: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const { orgId, siteId, versionId } = guard.value;
  // Targets come first in agent output: after cutover a deploy is a production release.
  const targets = await publicationTargets(orgId, siteId, versionId);
  try { return apiResponse(guard.value, { version_id: versionId, ...targets, ...await previewPublicationImpact(orgId, siteId, versionId) }); }
  catch { return apiError('Saved content could not be compared with the verified publication. Check content and template validity before deploying.', 409); }
};
