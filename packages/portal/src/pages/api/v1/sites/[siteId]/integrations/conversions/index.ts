// GET /api/v1/sites/{siteId}/integrations/conversions
//
// Form conversion status: the mode, which providers are set up, whether the
// Conversions API token and test code are set, and the last outcomes (what
// fired or waited for consent in the browser, what the server sent to Meta
// or skipped and why). No contact data. Admin permission.

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../../lib/api-auth';
import { conversionStatus } from '../../../../../../../lib/forms/conversions';

export const GET: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  if (guard.value.permission !== 'admin') return apiError('Insufficient permission (admin required)', 403, guard.value);
  return apiResponse(guard.value, await conversionStatus(guard.value.orgId, guard.value.siteId));
};
