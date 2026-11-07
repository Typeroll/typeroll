// GET  /api/sites/{siteId}/fonts   — the site's Fonts library and the roles
//      using each family: { fonts: SiteFontFile[], used_by: { [family]: role[] } }
// POST /api/sites/{siteId}/fonts   — upload a font file (multipart/form-data:
//      file, family?, weight? ("400" or "100-900"), style?, category?,
//      licence_confirmed ("true"), licence_note?) → 201 { font }
//
// The portal's session routes. Uploading is a site administrator's change,
// like the Settings form; reading needs read access.

import type { APIRoute } from 'astro';
import { requireSiteAccess, json, requirePermission } from '../../../../../lib/access';
import { addSiteFont, fontFailureBody, siteFontsResponse } from '../../../../../lib/fonts/font-library';
import { formText, uploadedFile, uploadForm } from '../../../../../lib/fonts/font-requests';

function fontFailure(error: unknown): Response {
  const refused = fontFailureBody(error);
  if (!refused) throw error;
  return json(refused.body, refused.status);
}

export const GET: APIRoute = async ({ cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const { site, owner_org_id } = guard.value;
  return json(await siteFontsResponse(owner_org_id, site.id));
};

export const POST: APIRoute = async ({ request, cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const adminCheck = requirePermission(guard.value, 'admin');
  if (!adminCheck.ok) return adminCheck.response;
  const { session, site, owner_org_id } = guard.value;
  try {
    const form = await uploadForm(request);
    const { bytes, filename } = await uploadedFile(form);
    const font = await addSiteFont(owner_org_id, site.id, {
      bytes, filename,
      family: formText(form, 'family'), weight: formText(form, 'weight'), style: formText(form, 'style'), category: formText(form, 'category'),
      licence_confirmed: formText(form, 'licence_confirmed'), licence_note: formText(form, 'licence_note'),
      by: session.email || session.userId,
    });
    return json({ font }, 201);
  } catch (error) { return fontFailure(error); }
};
