// GET /api/sites/{siteId}/blocks/types/starters
//
// Built-in starting points for a new block type (icon list, card grid, FAQ …).
// Each is a complete composed definition, written through the same validator
// as any other once the author saves it.

import type { APIRoute } from 'astro';
import { json, requireSiteAccess } from '../../../../../../lib/access';
import { blockTypeStarters } from '../../../../../../lib/block-type-write';

export const GET: APIRoute = async ({ cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  return json(blockTypeStarters());
};
