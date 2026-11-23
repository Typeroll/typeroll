import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../../lib/api-auth';
import { readPublishedPage } from '../../../../../../../lib/publishing/published-page';

export const GET: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  if (!params.pageId) return apiError('Missing pageId');
  const { orgId, siteId, versionId } = guard.value;
  try {
    const result = await readPublishedPage(orgId, siteId, versionId, params.pageId);
    return result ? apiResponse(guard.value, result) : apiError('This page has no readable verified publication', 404);
  } catch { return apiError('Published content could not be read; draft content was not substituted', 503); }
};
