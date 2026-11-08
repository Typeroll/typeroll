// POST /api/sites/{siteId}/fonts/services/inspect   — read a font service's
//      stylesheet and list its families, before adding it to fonts.services
//      JSON: { provider: "adobe", kit } | { provider: "bunny" | "fontshare", url }
//      → { families: string[], stylesheet: string }
//
// The stylesheet is fetched server-side with the guarded fetch (public
// addresses only, no redirects, 512 KB). Adding the service is a settings
// change (fonts.services), so this needs the same design permission
// (an administrator or builder).

import type { APIRoute } from 'astro';
import { requireSiteAccess, json, requireDesign } from '../../../../../../lib/access';
import { fontFailureBody } from '../../../../../../lib/fonts/font-library';
import { fontServiceInput, inspectFontService } from '../../../../../../lib/fonts/font-services';

export const POST: APIRoute = async ({ request, cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const designCheck = requireDesign(guard.value);
  if (!designCheck.ok) return designCheck.response;
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  try {
    return json(await inspectFontService(fontServiceInput(body)));
  } catch (error) {
    const refused = fontFailureBody(error);
    if (!refused) throw error;
    return json(refused.body, refused.status);
  }
};
