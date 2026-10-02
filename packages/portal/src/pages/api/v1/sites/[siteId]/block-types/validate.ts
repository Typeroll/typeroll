// POST /api/v1/sites/{siteId}/block-types/validate[?type_id=…]
//
// Check a block type definition without saving it, with the same validator
// the writes use. Body = the definition; with `?type_id=` it is a patch to
// that stored type (`renames` are checked too). Answers `{ ok, problems,
// merged }`: every error and warning with a JSON-pointer path (and a line
// for markup and CSS problems), and the definition as it would be stored.
// Writes nothing, so a read-only key may call it.

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../lib/api-auth';
import { validateBlockTypeDraft } from '../../../../../../lib/block-type-write';

export const POST: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId, { sideEffectFree: true });
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const body = await request.json().catch(() => null);
  if (body === null) return apiError('Invalid JSON', 400, ctx);
  const typeId = new URL(request.url).searchParams.get('type_id') ?? undefined;
  const outcome = await validateBlockTypeDraft(ctx, body, { typeId, allowScript: true });
  return apiResponse(ctx, outcome.body, outcome.status);
};
