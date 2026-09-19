import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../lib/api-auth';
import { DeliveryError, publicReceipt, sendApplicationEmail } from '../../../../../../lib/email/delivery';

export const POST: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  if (!ctx.extensionIdentity?.scopes.includes('email:send')) return apiError('An email-authorized installation credential is required', 403);
  const body = await request.json().catch(() => null);
  if (!body || typeof body.to !== 'string' || !/^[^\s@,;\r\n]+@[^\s@,;\r\n]+\.[^\s@,;\r\n]+$/.test(body.to) ||
      typeof body.subject !== 'string' || body.subject.length > 200 || /[\r\n]/.test(body.subject) ||
      typeof body.text !== 'string' || body.text.length > 32_000) return apiError('Invalid transactional email', 400);
  try {
    const receipt = await sendApplicationEmail({ orgId: ctx.orgId, siteId: ctx.siteId, installationId: ctx.extensionIdentity.installationId }, body);
    return apiResponse(ctx, publicReceipt(receipt), ['accepted', 'delivered'].includes(receipt.status) ? 202 : 409);
  } catch (error) {
    return apiError(error instanceof DeliveryError ? error.message : 'Site email delivery could not be completed', error instanceof DeliveryError ? error.status : 503);
  }
};
