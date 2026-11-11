// GET /api/v1/sites/{siteId}/extensions/{installationId}/variants?component_id=…
//
// The variants of an installed app contract component, asked from the app
// server side (`component_variants` assertion). Without a declared
// `variants` call the component has the single variant `standard`. Read
// access is enough. MCP: list_extension_variants.

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../../lib/api-auth';
import { ContractCallError, listExtensionVariants } from '../../../../../../../lib/extensions/contract-calls';

export const GET: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  if (ctx.extensionIdentity) return apiError('Site API key required', 403, ctx);
  const componentId = new URL(request.url).searchParams.get('component_id') ?? '';
  if (!params.installationId || !componentId) return apiError('component_id is required', 400, ctx);
  try {
    return apiResponse(ctx, await listExtensionVariants(ctx.orgId, ctx.siteId, params.installationId, componentId));
  } catch (error) {
    if (error instanceof ContractCallError) return apiError(error.message, error.status, ctx, { code: error.code });
    return apiError('The app did not list its variants', 502, ctx);
  }
};
