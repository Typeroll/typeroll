// GET    /api/v1/sites/{siteId}/forms/{formId}/submissions/{submissionId}
// DELETE /api/v1/sites/{siteId}/forms/{formId}/submissions/{submissionId}
//
// Read or remove one submission, like the portal's submission view. DELETE is
// the targeted counterpart to delete_form's delete_submissions flag — built
// for cleaning up individual entries (test submissions after a live form
// check, spam that slipped past the honeypot) without touching the rest of
// the inbox. Shares lib/form-submissions with the portal.

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../../../lib/api-auth';
import { deleteFormSubmission, formExists, readFormSubmission } from '../../../../../../../../lib/form-submissions';

export const GET: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const { formId, submissionId } = params;
  if (!formId) return apiError('Missing formId');
  if (!submissionId) return apiError('Missing submissionId');
  if (!(await formExists(ctx.orgId, ctx.siteId, formId))) return apiError('Form not found', 404, ctx);
  const submission = await readFormSubmission(ctx.orgId, ctx.siteId, formId, submissionId,
    ctx.permission === 'admin' && !ctx.extensionIdentity);
  if (!submission) return apiError('Submission not found', 404, ctx);
  return apiResponse(ctx, { submission, form_id: formId });
};

export const DELETE: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const { formId, submissionId } = params;
  if (!formId) return apiError('Missing formId');
  if (!submissionId) return apiError('Missing submissionId');
  if (!(await formExists(ctx.orgId, ctx.siteId, formId))) return apiError('Form not found', 404, ctx);
  // A valid submission id under the wrong form 404s — otherwise an agent could
  // delete form A's lead while believing it cleaned up form B.
  if (!(await deleteFormSubmission(ctx.orgId, ctx.siteId, formId, submissionId))) return apiError('Submission not found', 404, ctx);
  return apiResponse(ctx, { ok: true, deleted_submission_id: submissionId, form_id: formId });
};
