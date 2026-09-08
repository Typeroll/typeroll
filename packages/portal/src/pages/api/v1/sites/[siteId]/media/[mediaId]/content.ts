import type { APIRoute } from 'astro';
import { requireApiKey, apiResponse } from '../../../../../../../lib/api-auth';
import { privateMediaReadUrl } from '../../../../../../../lib/publishing/media-storage';
import { connectionFailure } from '../../../../../../../lib/publishing/http';

export const GET: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  try {
    const response = apiResponse(guard.value, { read_url: await privateMediaReadUrl(guard.value.orgId, guard.value.siteId, params.mediaId!), expires_in: 60 });
    response.headers.set('Cache-Control', 'no-store');
    return response;
  } catch (error) { return connectionFailure(error); }
};
