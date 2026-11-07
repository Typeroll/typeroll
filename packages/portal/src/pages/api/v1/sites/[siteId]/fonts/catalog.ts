// GET /api/v1/sites/{siteId}/fonts/catalog?query=&category=&variable=&italic=&latin_ext=&limit=
//
// Search the font catalog (250 open-licence Google families with their
// weights, italics, variable axis and extended Latin support) and the site's
// own families: uploaded files (`library`) and font services (`services`),
// filtered by the same query. category takes one or more of sans, serif,
// display, handwriting, mono (comma separated).
//   → { fonts: [{ family, category, weights, italic?, variable?, latin_ext?, source: "google" }],
//       library: [{ family, source: "upload", weights, italic }],
//       services: [{ family, source: "service", provider }] }

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../lib/api-auth';
import { fontCatalogResponse, fontFailureBody, fontSearchFilters } from '../../../../../../lib/fonts/font-library';

export const GET: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  try {
    return apiResponse(ctx, await fontCatalogResponse(ctx.orgId, ctx.siteId, fontSearchFilters(new URL(request.url).searchParams)));
  } catch (error) {
    const refused = fontFailureBody(error);
    if (!refused) throw error;
    return apiError(refused.body.error, refused.status, ctx, { code: refused.body.code });
  }
};
