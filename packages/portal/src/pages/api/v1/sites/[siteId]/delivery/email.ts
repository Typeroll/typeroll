import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../lib/api-auth';
import { DeliveryError, publicReceipt, sendApplicationEmail } from '../../../../../../lib/email/delivery';
import { readDelivery } from '../../../../../../lib/email/delivery';
import { applicationDeliveryId } from '../../../../../../lib/email/queue';

/** Lookup without resending, including when the first POST response was lost. */
export const GET: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  if (!ctx.extensionIdentity?.scopes.includes('email:send')) return apiError('An email-authorized installation credential is required', 403);
  const key = new URL(request.url).searchParams.get('idempotency_key') ?? '';
  if (!/^[A-Za-z0-9_-]{16,100}$/.test(key)) return apiError('Supply the original idempotency_key');
  const scope = { orgId: ctx.orgId, siteId: ctx.siteId, installationId: ctx.extensionIdentity.installationId };
  const receipt = await readDelivery(scope, applicationDeliveryId(scope, key));
  return receipt ? apiResponse(ctx, publicReceipt(receipt)) : apiError('Message not found', 404);
};

export const POST: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  if (!ctx.extensionIdentity?.scopes.includes('email:send')) return apiError('An email-authorized installation credential is required', 403);
  const body = await request.json().catch(() => null);
  if (!body || typeof body.to !== 'string' || !/^[^\s@,;\r\n]+@[^\s@,;\r\n]+\.[^\s@,;\r\n]+$/.test(body.to) ||
      typeof body.subject !== 'string' || body.subject.length > 200 || /[\r\n]/.test(body.subject) ||
      typeof body.text !== 'string' || body.text.length > 32_000 ||
      (body.format !== undefined && body.format !== 'text' && body.format !== 'linked_text') ||
      (body.category !== undefined && !['transactional', 'bulk'].includes(body.category)) ||
      (body.delivery_group !== undefined && (typeof body.delivery_group !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(body.delivery_group)))) return apiError('Invalid application email', 400);
  try {
    const receipt = await sendApplicationEmail({ orgId: ctx.orgId, siteId: ctx.siteId, installationId: ctx.extensionIdentity.installationId }, body, { category: body.category === 'bulk' ? 'bulk' : 'transactional', deliveryGroup: body.delivery_group });
    return apiResponse(ctx, publicReceipt(receipt), ['accepted', 'delivered'].includes(receipt.status) ? 202 : 409);
  } catch (error) {
    return apiError(error instanceof DeliveryError ? error.message : 'Site email delivery could not be completed', error instanceof DeliveryError ? error.status : 503);
  }
};
