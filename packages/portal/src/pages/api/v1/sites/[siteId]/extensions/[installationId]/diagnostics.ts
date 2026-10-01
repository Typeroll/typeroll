// GET /api/v1/sites/{siteId}/extensions/{installationId}/diagnostics
//
// The portal's installation diagnostics: status, health, release resolution,
// credential metadata (no secrets), the latest 50 audit events and lifecycle
// event deliveries, and declared URL context. Requires site administrator
// access.

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../../lib/api-auth';
import { readExtensionDiagnostics } from '../../../../../../../lib/extensions/diagnostics';

export const GET: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  if (ctx.permission !== 'admin' || ctx.extensionIdentity) return apiError('Admin permission required', 403, ctx);
  if (!params.installationId) return apiError('Missing installationId', 400, ctx);
  const diagnostics = await readExtensionDiagnostics(ctx.orgId, ctx.siteId, params.installationId);
  if (!diagnostics) return apiError('Installation not found', 404, ctx);
  return apiResponse(ctx, diagnostics);
};
