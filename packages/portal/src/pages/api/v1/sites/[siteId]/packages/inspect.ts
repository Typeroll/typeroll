// POST /api/v1/sites/{siteId}/packages/inspect   — what importing a package would do
//      JSON: { data_base64 | source_url, options? } → { package, signature, plan, warnings, errors, needs }
//
// data_base64 holds at most 32 MB; source_url (https, public address) up to
// the package limit of 200 MB. Writes nothing, so read permission is enough.

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../lib/api-auth';
import { inspectSitePackage, parseImportOptions } from '../../../../../../lib/packages/package-import';
import { packageFromJson } from '../../../../../../lib/packages/package-requests';
import { packageApiFailure } from '../../../../../../lib/packages/package-api';

export const POST: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  if (ctx.extensionIdentity) return apiError('Extension credentials cannot import packages', 403, ctx);
  try {
    const { bytes, options } = await packageFromJson(request);
    return apiResponse(ctx, await inspectSitePackage(ctx.orgId, ctx.siteId, ctx.versionId, bytes, parseImportOptions(options)));
  } catch (error) { return packageApiFailure(error, ctx); }
};
