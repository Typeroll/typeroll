// POST /api/v1/sites/{siteId}/extensions/{installationId}/rotate-credential
//
// Refused: a new installation server credential is issued only in the portal
// (Site settings → Extensions), so the plaintext is shown once to the person
// rotating it and never lands in an agent conversation or log.

import type { APIRoute } from 'astro';
import { apiError, requireApiKey, withApiIdentity } from '../../../../../../../lib/api-auth';

export const POST: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  return withApiIdentity(ctx, apiError('Extension credentials are rotated in the portal (Site settings → Extensions), so the new credential is shown only to the person rotating it and never lands in an agent conversation or log.', 403, ctx));
};
