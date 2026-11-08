// POST /api/v1/sites/{siteId}/extensions/{installationId}/connect
//
// Connects an installation to its provider: Typeroll mints a new service
// credential and delivers it straight to the manifest's
// `auth.provisioning_url`. The caller never sees it. Installing such an
// Extension already does this; call it again to reconnect (for example after
// the provider lost its binding or the granted scopes changed).

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../../lib/api-auth';
import { provisionInstallationCredential } from '../../../../../../../lib/extensions/credential-provisioning';
import { ExtensionRegistryError } from '../../../../../../../lib/extensions/registry';

export const POST: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  if (ctx.permission !== 'admin' || ctx.extensionIdentity) return apiError('Admin permission required', 403, ctx);
  // The credential belongs to the owner and outlives any share.
  if (ctx.tokenOrgId !== ctx.orgId) return apiError('Only the owning organization can connect Extensions', 403, ctx);
  if (!params.installationId) return apiError('Missing installationId', 400, ctx);
  try {
    const result = await provisionInstallationCredential({
      ownerOrgId: ctx.orgId,
      siteId: ctx.siteId,
      installationId: params.installationId,
      actorId: `api:${ctx.keyPrefix}`,
    });
    return apiResponse(ctx, { status: 'connected', ...result });
  } catch (error) {
    if (error instanceof ExtensionRegistryError) return apiError(error.message, error.status, ctx);
    return apiError('Connecting the Extension failed', 500, ctx);
  }
};
