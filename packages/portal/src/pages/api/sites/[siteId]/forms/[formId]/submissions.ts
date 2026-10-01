// Cookie-auth: list submissions for one form (newest first, paginated).
// Admins also see webhook delivery status. Shares lib/form-submissions with
// the v1 API and MCP (list_form_submissions).

import type { APIRoute } from 'astro';
import { requireSiteAccess, json } from '../../../../../../lib/access';
import { formExists, listFormSubmissions } from '../../../../../../lib/form-submissions';

export const GET: APIRoute = async ({ request, cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const { site, owner_org_id } = guard.value;
  const formId = params.formId;
  if (!formId) return json({ error: 'Missing formId' }, 400);
  if (!(await formExists(owner_org_id, site.id, formId))) return json({ error: 'Form not found' }, 404);

  const url = new URL(request.url);
  return json(await listFormSubmissions(owner_org_id, site.id, formId, {
    limit: url.searchParams.get('limit'),
    cursor: url.searchParams.get('cursor'),
    isAdmin: guard.value.permission === 'admin',
  }));
};
