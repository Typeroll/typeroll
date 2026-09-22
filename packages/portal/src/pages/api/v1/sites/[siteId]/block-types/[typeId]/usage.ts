// GET /api/v1/sites/{siteId}/block-types/{typeId}/usage
//
// Pages that use a block of this type. Today's pages are HTML-mode so the
// result is always empty — when block-mode pages exist, this scans their
// blocks tree for matches. Shape locked in now so future block-editor work
// drops in cleanly.

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../../lib/api-auth';
import { getBlockTypeUsage } from '../../../../../../../lib/block-type-usage';
import { pathParam } from '../../../../../../../lib/path-param';

export const GET: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const typeId = pathParam(params.typeId);
  if (!typeId) return apiError('Missing typeId');

  // Every surface that can hold a block, because "is this used" must not
  // depend on where it is used. Pages only was the original defect.
  const usage = await getBlockTypeUsage(ctx.orgId, ctx.siteId, ctx.versionId, typeId);
  return apiResponse(ctx, { type_id: typeId, ...usage });
};
