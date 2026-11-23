import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../../lib/api-auth';
import { siteEmailQueuePolicy } from '../../../../../../../lib/email/configuration';

export const GET: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  if (!ctx.extensionIdentity?.scopes.includes('email:send')) return apiError('An email-authorized installation credential is required', 403);
  return apiResponse(ctx, await siteEmailQueuePolicy(ctx.orgId, ctx.siteId));
};
