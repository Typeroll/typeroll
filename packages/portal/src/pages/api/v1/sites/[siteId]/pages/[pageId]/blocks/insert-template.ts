// POST /api/v1/sites/{siteId}/pages/{pageId}/blocks/insert-template
//   { template_id, parent_id?, slot_index?, position? } — insert a copy of a block template.
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
  const result = await runReusableAction(ctx, params.pageId, 'insert_template', body);
  return result.status === 200 ? apiResponse(ctx, result.body) : apiError(String(result.body.error), result.status);
};
