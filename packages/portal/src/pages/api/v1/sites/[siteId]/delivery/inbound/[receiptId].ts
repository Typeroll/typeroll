import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../../lib/api-auth';
import { inboundRoutes, readInboundReceipt } from '../../../../../../../lib/email/inbound';
export const GET: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  if (!ctx.extensionIdentity && ctx.permission !== 'admin') return apiError('Site administration is required', 403);
  const routes = inboundRoutes().filter(r => r.orgId === ctx.orgId && r.siteId === ctx.siteId &&
    (!ctx.extensionIdentity || r.installationId === ctx.extensionIdentity.installationId));
  for (const route of routes) {
    const receipt = await readInboundReceipt(route, params.receiptId ?? '');
    if (receipt) return apiResponse(ctx, receipt);
  }
  return apiError('Incoming email receipt not found', 404);
};
