// POST /api/v1/sites/{siteId}/integrations/email/test   { to }
//
// Send a test email through the stored connector, like "Send test" in the
// portal's Settings → Email & notifications. Admin permission required.

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../../lib/api-auth';
import { EmailSettingsError, sendTestEmail } from '../../../../../../../lib/email/site-email-settings';

export const POST: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  if (ctx.permission !== 'admin') return apiError('Insufficient permission (admin required)', 403, ctx);
  const body = await request.json().catch(() => null);
  try {
    return apiResponse(ctx, await sendTestEmail(ctx.orgId, ctx.site, body), 200, body);
  } catch (error) {
    if (error instanceof EmailSettingsError) return apiError(error.message, error.status, ctx);
    throw error;
  }
};
