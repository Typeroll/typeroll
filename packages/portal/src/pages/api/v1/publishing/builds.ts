import type { APIRoute } from 'astro';
import { requireAnyApiKey, apiResponse, apiError } from '../../../../lib/api-auth';
import { connectionFailure, publishingJsonBody } from '../../../../lib/publishing/http';
import { readBuildSettings, configureBuildSettings } from '../../../../lib/builds/selection';
async function handle(request: Request, write: boolean) {
  const guard = await requireAnyApiKey(request);
  if (!guard.ok) return guard.response;
  if (guard.value.tokenSiteId !== null) return apiError('An organization API key is required to manage builds.', 403);
  try {
    const result = write ? await configureBuildSettings(guard.value.tokenOrgId, await publishingJsonBody(request)) : await readBuildSettings(guard.value.tokenOrgId);
    const response = apiResponse(guard.value, result); response.headers.set('Cache-Control', 'no-store'); return response;
  } catch (error) { return connectionFailure(error); }
}
export const GET: APIRoute = ({ request }) => handle(request, false);
export const POST: APIRoute = ({ request }) => handle(request, true);
