// GET /api/v1/sites/{siteId}/forms/{formId}/submissions
//
// Lists submissions received for one form. Newest first; cursor-paginated;
// capped at 200 per page. Useful for an agent helping a customer triage
// inbound leads ("show me the last 20 contact-form submissions"). Admins also
// see each submission's webhook delivery status, as in the portal
// (lib/form-submissions).

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../../lib/api-auth';
import { formExists, listFormSubmissions } from '../../../../../../../lib/form-submissions';

export const GET: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const formId = params.formId;
  if (!formId) return apiError('Missing formId');

  // Confirm the form exists. Listing submissions for an unknown form would
  // silently return [] and mislead the agent into thinking the form has
  // no leads when actually the form id is wrong.
  if (!(await formExists(ctx.orgId, ctx.siteId, formId))) return apiError('Form not found', 404, ctx);

  const url = new URL(request.url);
  return apiResponse(ctx, await listFormSubmissions(ctx.orgId, ctx.siteId, formId, {
    limit: url.searchParams.get('limit'),
    cursor: url.searchParams.get('cursor'),
    // Delivery status is admin information in the portal; an installation
    // credential with submissions:read gets the submissions only.
    isAdmin: ctx.permission === 'admin' && !ctx.extensionIdentity,
  }));
};
