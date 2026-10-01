// POST /api/v1/sites/{siteId}/extensions/{installationId}/rotate-credential
//   body: { grace_seconds?: number }
//
// Issues a new installation server credential. The plaintext is returned
// once, exactly as the portal shows it once; store it in the provider's
// secret store. Earlier credentials keep working for the grace period
// (default five minutes). Requires site administrator access.

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../../lib/api-auth';
import { ExtensionAuthError, rotateInstallationCredential } from '../../../../../../../lib/extensions/auth';

export const POST: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  if (ctx.permission !== 'admin' || ctx.extensionIdentity) return apiError('Admin permission required', 403, ctx);
  if (!params.installationId) return apiError('Missing installationId', 400, ctx);
  const body = await request.json().catch(() => ({})) as { grace_seconds?: unknown } | null;
  const grace = Number(body?.grace_seconds);
  try {
    const rotated = await rotateInstallationCredential({
      ownerOrgId: ctx.orgId,
      siteId: ctx.siteId,
      installationId: params.installationId,
      actorId: `api:${ctx.keyPrefix}`,
      graceSeconds: body?.grace_seconds !== undefined && Number.isFinite(grace) ? grace : undefined,
    });
    const response = apiResponse(ctx, rotated, 200, { grace_seconds: body?.grace_seconds });
    response.headers.set('Cache-Control', 'private, no-store');
    return response;
  } catch (error) {
    if (error instanceof ExtensionAuthError) return apiError(error.message, error.status, ctx);
    return apiError('Failed to rotate credential', 500, ctx);
  }
};
