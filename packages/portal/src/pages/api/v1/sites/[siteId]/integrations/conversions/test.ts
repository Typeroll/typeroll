// POST /api/v1/sites/{siteId}/integrations/conversions/test   { meta_event?: "Lead" | "CompleteRegistration" }
//
// Sends one synthetic Meta Conversions API event with the site's test event
// code, so it shows under Events Manager → Test events. Creates no
// submission and no registration; its user data is a random external id.
// The outcome is added to the conversion status log. Admin permission.

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../../lib/api-auth';
import { sendTestConversion } from '../../../../../../../lib/forms/conversions';

export const POST: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  if (guard.value.permission !== 'admin') return apiError('Insufficient permission (admin required)', 403, guard.value);
  const body = await request.json().catch(() => ({})) as { meta_event?: unknown };
  const result = await sendTestConversion({
    orgId: guard.value.orgId,
    siteId: guard.value.siteId,
    metaEvent: typeof body?.meta_event === 'string' ? body.meta_event : undefined,
  });
  if (!result.ok && !result.entry) return apiError(result.error ?? 'The test conversion could not be sent', 409, guard.value);
  return apiResponse(guard.value, result, result.ok ? 200 : 502);
};
