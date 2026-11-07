// POST /api/sites/{siteId}/fonts/inspect   — read a font file without saving it
//      (multipart/form-data: file) → { info: FontFileInfo }
//
// The upload form uses it to prefill the family, weight and style the file
// declares; the upload itself goes to POST /api/sites/{siteId}/fonts.

import type { APIRoute } from 'astro';
import { requireSiteAccess, json, requirePermission } from '../../../../../lib/access';
import { fontFailureBody, inspectFontBytes } from '../../../../../lib/fonts/font-library';
import { uploadedFile, uploadForm } from '../../../../../lib/fonts/font-requests';

export const POST: APIRoute = async ({ request, cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const adminCheck = requirePermission(guard.value, 'admin');
  if (!adminCheck.ok) return adminCheck.response;
  try {
    const { bytes } = await uploadedFile(await uploadForm(request));
    return json({ info: inspectFontBytes(bytes) });
  } catch (error) {
    const refused = fontFailureBody(error);
    if (!refused) throw error;
    return json(refused.body, refused.status);
  }
};
