import type { APIRoute } from 'astro';
import { requireApiKey, apiResponse, apiError } from '../../../../../../lib/api-auth';
import { previewPublicationImpact } from '../../../../../../lib/publishing/impact-preview';
import { publicationTargets } from '../../../../../../lib/publishing/publication-targets';
import { buildEngineRuntime } from '../../../../../../lib/builds/selection';

export const GET: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const { orgId, siteId, versionId } = guard.value;
  // Targets come first in agent output: after cutover a deploy is a production release.
  const targets = await publicationTargets(orgId, siteId, versionId);
  // The engine's Node.js against this Typeroll's: a new Core can require a newer one.
  const buildEngine = await buildEngineRuntime(orgId).catch(() => null);
  try { return apiResponse(guard.value, { version_id: versionId, ...targets, ...await previewPublicationImpact(orgId, siteId, versionId), ...(buildEngine ? { build_engine: buildEngine } : {}) }); }
  catch { return apiError('Saved content could not be compared with the verified publication. Check content and template validity before deploying.', 409); }
};
