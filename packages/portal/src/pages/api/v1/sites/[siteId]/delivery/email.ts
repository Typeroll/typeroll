import type { APIRoute } from 'astro';
import { paths, type SiteIntegrations } from '@typeroll/shared';
import { apiError, apiResponse, requireApiKey } from '../../../../../../lib/api-auth';
import { getStore } from '../../../../../../lib/datastore';
import { sendViaConnector } from '../../../../../../lib/email';

export const POST: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  if (!ctx.extensionIdentity?.scopes.includes('email:send')) return apiError('An email-authorized installation credential is required', 403);
  const body = await request.json().catch(() => null);
  if (!body || typeof body.to !== 'string' || !/^[^\s@,;\r\n]+@[^\s@,;\r\n]+\.[^\s@,;\r\n]+$/.test(body.to) ||
      typeof body.subject !== 'string' || body.subject.length > 200 || /[\r\n]/.test(body.subject) ||
      typeof body.text !== 'string' || body.text.length > 32_000) return apiError('Invalid transactional email', 400);
  const integrations = await getStore().getDoc<SiteIntegrations>(paths.integrations(ctx.orgId, ctx.siteId));
  if (!integrations?.email) return apiError('Site email delivery is not configured', 409);
  const delivery = await sendViaConnector(integrations.email, { from: '', to: body.to, subject: body.subject, text: body.text });
  if (!delivery.ok) return apiError('Site email delivery failed', 502);
  return apiResponse(ctx, { accepted: true }, 202);
};
