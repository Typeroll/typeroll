import type { APIRoute } from 'astro';
import { apiResponse, requireApiKey } from '../../../../../../lib/api-auth';
import { siteAppDocumentation } from '../../../../../../lib/apps/documentation';

export const GET: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const response = apiResponse(ctx, await siteAppDocumentation(ctx.orgId, ctx.siteId));
  response.headers.set('Cache-Control', 'private, no-store');
  return response;
};
