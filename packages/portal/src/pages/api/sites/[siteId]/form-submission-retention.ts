// POST /api/sites/{siteId}/form-submission-retention  body: { days: number | null }
//
// Cookie-auth counterpart of `form_submission_retention_days` in the v1 site
// settings API, for the portal's Forms page. Admin only. Null keeps completed
// submissions until someone deletes them (the default); a number of days
// deletes each completed submission that long after it was completed,
// including existing ones (lib/form-submissions).

import type { APIRoute } from 'astro';
import { requireSiteAccess, requirePermission, json } from '../../../../lib/access';
import { setSubmissionRetention, submissionRetentionError } from '../../../../lib/form-submissions';

export const POST: APIRoute = async ({ request, cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const adminCheck = requirePermission(guard.value, 'admin');
  if (!adminCheck.ok) return adminCheck.response;
  const { site, owner_org_id } = guard.value;
  const body = (await request.json().catch(() => null)) as { days?: unknown } | null;
  if (!body || body.days === undefined) return json({ error: 'days is required (a number of days, or null to keep submissions)' }, 400);
  const error = submissionRetentionError(body.days);
  if (error) return json({ error }, 400);
  return json({ ok: true, ...(await setSubmissionRetention(owner_org_id, site.id, body.days as number | null)) });
};
