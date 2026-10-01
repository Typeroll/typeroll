// Cookie-auth: read / delete a single form submission. Shares
// lib/form-submissions with the v1 API and MCP (read_form_submission,
// delete_form_submission).

import type { APIRoute } from 'astro';
import { requireSiteAccess, requirePermission, json } from '../../../../../../../lib/access';
import { deleteFormSubmission, readFormSubmission } from '../../../../../../../lib/form-submissions';

export const GET: APIRoute = async ({ cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const { site, owner_org_id } = guard.value;
  const { formId, submissionId } = params;
  if (!formId || !submissionId) return json({ error: 'Missing id' }, 400);
  const submission = await readFormSubmission(owner_org_id, site.id, formId, submissionId, guard.value.permission === 'admin');
  if (!submission) return json({ error: 'Not found' }, 404);
  return json({ submission });
};

export const DELETE: APIRoute = async ({ cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const writeCheck = requirePermission(guard.value, 'write');
  if (!writeCheck.ok) return writeCheck.response;
  const { site, owner_org_id } = guard.value;
  const { formId, submissionId } = params;
  if (!formId || !submissionId) return json({ error: 'Missing id' }, 400);
  if (!(await deleteFormSubmission(owner_org_id, site.id, formId, submissionId))) return json({ error: 'Not found' }, 404);
  return json({ ok: true });
};
