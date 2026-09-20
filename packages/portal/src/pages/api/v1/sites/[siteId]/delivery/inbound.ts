import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../lib/api-auth';
import { DeliveryError } from '../../../../../../lib/email/delivery';
import { setInboundRoute, siteInboundRoutes } from '../../../../../../lib/email/inbound';

export const GET: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  if (!ctx.extensionIdentity && ctx.permission !== 'admin') return apiError('Site administration is required', 403);
  try { return apiResponse(ctx, { routes: await siteInboundRoutes(ctx.orgId, ctx.siteId, ctx.extensionIdentity?.installationId) }); }
  catch { return apiError('Incoming email host configuration is unavailable', 503); }
};
export const PUT: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  if (ctx.extensionIdentity || ctx.permission !== 'admin') return apiError('Site administration is required', 403);
  try {
    const body = await request.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) return apiError('Invalid incoming email settings', 400);
    await setInboundRoute(ctx.orgId, ctx.siteId, body);
    return apiResponse(ctx, { routes: await siteInboundRoutes(ctx.orgId, ctx.siteId) });
  } catch (error) { return apiError(error instanceof DeliveryError ? error.message : 'Could not save incoming email settings', error instanceof DeliveryError ? error.status : 400); }
};
