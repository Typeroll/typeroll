// POST /api/v1/sites/{siteId}/pages/{pageId}/blocks/make-global
//   { block_id, name?, global_block_id? } — move a block into a new global block and reference it in place.
// Writes the page draft (working copy) like other block mutations.

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../../../lib/api-auth';
import { runReusableAction } from '../../../../../../../../lib/reusable-block-actions';

export const POST: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  if (!params.pageId) return apiError('Missing pageId');
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return apiError('Body must be a JSON object');
  const result = await runReusableAction(ctx, params.pageId, 'make_global', body);
  return result.status === 200 ? apiResponse(ctx, result.body) : apiError(String(result.body.error), result.status);
};
