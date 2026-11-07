// POST /api/v1/sites/{siteId}/packages/import   — import a package into the site
//      JSON: { data_base64 | source_url, options } → { report }
//
// options: { design: "content" | "styles" | "full", fonts?, only?, font_licence_confirmed? }.
// Needs write permission; design (an administrator or builder) when
// options.design is "full", or when the import adds fonts or settings pages. Fonts need font_licence_confirmed.

import type { APIRoute } from 'astro';
import { apiCanDesign, apiError, apiResponse, requireApiKey } from '../../../../../../lib/api-auth';
import { importSitePackage, parseImportOptions } from '../../../../../../lib/packages/package-import';
import { packageFromJson } from '../../../../../../lib/packages/package-requests';
import { apiUpdatedBy } from '../../../../../../lib/snippet-write';
import { packageApiFailure } from '../../../../../../lib/packages/package-api';

export const POST: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  if (ctx.extensionIdentity) return apiError('Extension credentials cannot import packages', 403, ctx);
  if (ctx.permission === 'read') return apiError('Insufficient permission (write required)', 403, ctx);
  try {
    const { bytes, options } = await packageFromJson(request);
    const parsed = parseImportOptions(options);
    const report = await importSitePackage({ orgId: ctx.orgId, siteId: ctx.siteId, versionId: ctx.versionId, permission: ctx.permission, design: apiCanDesign(ctx), actor: apiUpdatedBy(ctx.keyPrefix) }, bytes, parsed);
    return apiResponse(ctx, { report }, 200, { options: parsed });
  } catch (error) { return packageApiFailure(error, ctx); }
};
