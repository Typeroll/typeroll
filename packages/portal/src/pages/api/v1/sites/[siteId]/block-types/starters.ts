// GET /api/v1/sites/{siteId}/block-types/starters
//
// Built-in starting points for a new site block type (icon list, card grid,
// FAQ, steps, logo row, quote). Each `definition` is a complete composed
// block type: adapt it and send it to POST /block-types.

import type { APIRoute } from 'astro';
import { apiResponse, requireApiKey } from '../../../../../../lib/api-auth';
import { blockTypeStarters } from '../../../../../../lib/block-type-write';

export const GET: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  return apiResponse(guard.value, blockTypeStarters());
};
