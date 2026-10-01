// GET /api/v1/sites/{siteId}/form-capabilities
//
// The action types (core email/webhook plus app-provided ones) and prefill
// sources a form may use, with each type's config schema — the same list the
// portal's Forms editor offers. Read it before writing a form's `actions`.
// Admin permission, like the portal route and like writing actions.

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../lib/api-auth';
import { formCapabilities } from '../../../../../lib/form-capabilities';

export const GET: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  if (ctx.permission !== 'admin') return apiError('Insufficient permission (admin required)', 403, ctx);
  return apiResponse(ctx, await formCapabilities());
};
