// POST /api/v1/sites/{siteId}/extensions/{installationId}/pair
//
// Explicitly pairs this Typeroll instance's token issuer with the provider's
// declared `auth.pairing_url`, the same action as the portal's secure
// connection button. Requires site administrator access.

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../../lib/api-auth';
import { ExtensionRegistryError } from '../../../../../../../lib/extensions/registry';
import { pairExtensionIssuer } from '../../../../../../../lib/extensions/trust-pairing';

export const POST: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  if (ctx.permission !== 'admin' || ctx.extensionIdentity) return apiError('Admin permission required', 403, ctx);
  if (!params.installationId) return apiError('Missing installationId', 400, ctx);
  try {
    const issuer = await pairExtensionIssuer({
      ownerOrgId: ctx.orgId,
      siteId: ctx.siteId,
      installationId: params.installationId,
      actorId: `api:${ctx.keyPrefix}`,
    });
    return apiResponse(ctx, { issuer });
  } catch (error) {
    if (error instanceof ExtensionRegistryError) return apiError(error.message, error.status, ctx);
    return apiError('Issuer pairing failed', 500, ctx);
  }
};
