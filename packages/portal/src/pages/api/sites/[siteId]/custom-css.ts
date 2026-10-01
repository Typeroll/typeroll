// PUT /api/sites/{siteId}/custom-css  body: { css }
//
// Portal (session) route for the Site CSS editor on the Styles page. Same
// checks as PATCH /api/v1/sites/{siteId}/settings with `custom_css`: errors
// refuse the write, warnings come back. Admins only, like other site-wide
// code settings.

import type { APIRoute } from 'astro';
import { json, requirePermission, requireSiteAccess } from '../../../../lib/access';
import { vstore } from '../../../../lib/version-store';
import { customCssWarnings, customCssWriteError } from '../../../../lib/custom-css-write';

export const PUT: APIRoute = async ({ request, cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const admin = requirePermission(guard.value, 'admin');
  if (!admin.ok) return admin.response;
  const body = (await request.json().catch(() => null)) as { css?: unknown } | null;
  if (!body || typeof body.css !== 'string') return json({ error: 'css must be text' }, 400);
  const error = customCssWriteError(body.css);
  if (error) return json({ error }, 400);
  const { site, versionId, owner_org_id } = guard.value;
  await vstore.writeSettings(owner_org_id, site.id, versionId, { custom_css: body.css.trim() ? body.css : '' });
  return json({ ok: true, warnings: customCssWarnings(body.css).map(problem => `Line ${problem.line}: ${problem.message}`) });
};
