import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../../lib/api-auth';
import { publicReceipt, readDelivery } from '../../../../../../../lib/email/delivery';

export const GET: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  if (!ctx.extensionIdentity?.scopes.includes('email:send')) return apiError('An email-authorized installation credential is required', 403);
  const receipt = await readDelivery({ orgId: ctx.orgId, siteId: ctx.siteId, installationId: ctx.extensionIdentity.installationId }, params.messageId ?? '');
  return receipt ? apiResponse(ctx, publicReceipt(receipt)) : apiError('Message not found', 404);
};
