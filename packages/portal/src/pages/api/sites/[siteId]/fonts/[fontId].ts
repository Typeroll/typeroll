// PATCH  /api/sites/{siteId}/fonts/{fontId}   — correct a library file
//        JSON: { family?, weight?, style?, category?, licence_note? } → { font }
// DELETE /api/sites/{siteId}/fonts/{fontId}   — remove it and its stored bytes
//        → { deleted: true, warning? } (warning names the roles that fall back)
//
// The portal's session routes; both are site administration.

import type { APIRoute } from 'astro';
import { requireSiteAccess, json, requirePermission } from '../../../../../lib/access';
import { pathParam } from '../../../../../lib/path-param';
import { deleteSiteFont, fontFailureBody, updateSiteFont } from '../../../../../lib/fonts/font-library';

function fontFailure(error: unknown): Response {
  const refused = fontFailureBody(error);
  if (!refused) throw error;
  return json(refused.body, refused.status);
}

export const PATCH: APIRoute = async ({ request, cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const adminCheck = requirePermission(guard.value, 'admin');
  if (!adminCheck.ok) return adminCheck.response;
  const { site, owner_org_id } = guard.value;
  const id = pathParam(params.fontId);
  if (!id) return json({ error: 'Missing fontId' }, 400);
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'Invalid JSON body' }, 400);
  try {
    return json({ font: await updateSiteFont(owner_org_id, site.id, id, body) });
  } catch (error) { return fontFailure(error); }
};

export const DELETE: APIRoute = async ({ cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const adminCheck = requirePermission(guard.value, 'admin');
  if (!adminCheck.ok) return adminCheck.response;
  const { site, owner_org_id } = guard.value;
  const id = pathParam(params.fontId);
  if (!id) return json({ error: 'Missing fontId' }, 400);
  try {
    return json(await deleteSiteFont(owner_org_id, site.id, id));
  } catch (error) { return fontFailure(error); }
};
