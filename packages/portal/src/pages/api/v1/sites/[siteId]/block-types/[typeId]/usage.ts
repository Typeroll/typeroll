// GET /api/v1/sites/{siteId}/block-types/{typeId}/usage
//
// Everything that uses a block type, on every surface that can hold one:
// - `pages` (saved block pages and drafts; `sources` says which),
// - `templates` (page templates),
// - `partials` (headers, footers and global blocks, saved and draft),
// - `block_templates`,
// - `block_types`: other site block types built from it (composition,
//   alias target or repeater item).
// A use through another block type names it in `via`; repeaters that render
// the type as their `item_block` count as uses. `total` sums the lists;
// deleting the type is refused while it is above zero.

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../../lib/api-auth';
import { getBlockTypeUsage, usageCount } from '../../../../../../../lib/block-type-usage';
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
  return apiResponse(ctx, { type_id: typeId, total: usageCount(usage), ...usage });
};
