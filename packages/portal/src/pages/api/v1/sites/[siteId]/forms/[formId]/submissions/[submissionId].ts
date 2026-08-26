// DELETE /api/v1/sites/{siteId}/forms/{formId}/submissions/{submissionId}
//
// Removes one submission from a form's inbox. The targeted counterpart to
// delete_form's nuke-everything delete_submissions flag — built for cleaning
// up individual entries (test submissions after a live form check, spam that
// slipped past the honeypot) without touching the rest of the inbox.

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../../../lib/api-auth';
import { getStore } from '../../../../../../../../lib/datastore';
import { paths } from '@typeroll/shared';
import type { FormSubmission } from '@typeroll/shared';

export const DELETE: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const formId = params.formId;
  const submissionId = params.submissionId;
  if (!formId) return apiError('Missing formId');
  if (!submissionId) return apiError('Missing submissionId');

  const store = getStore();
  const form = await store.getDoc(`${paths.forms(ctx.orgId, ctx.siteId)}/${formId}`);
  if (!form) return apiError('Form not found', 404);

  const subPath = `${paths.submissions(ctx.orgId, ctx.siteId)}/${submissionId}`;
  const sub = await store.getDoc<FormSubmission>(subPath);
  // Submissions live in one per-site collection keyed by form_id, so a valid
  // submission id under the wrong form must 404 — otherwise an agent could
  // delete form A's lead while believing it cleaned up form B.
  if (!sub || sub.form_id !== formId) return apiError('Submission not found', 404);

  await store.deleteDoc(subPath);
  return apiResponse(ctx, { ok: true, deleted_submission_id: submissionId, form_id: formId });
};
