// POST /api/v1/sites/{siteId}/block-types/preview
//
// Render a block type definition that need not be saved, through the same
// preview renderer as the portal: the site's render version, theme CSS,
// named styles and custom CSS, the other site block types and the
// sanitizer. Body: `{ definition, data?, render_version?, type_id? }` —
// without `data` the block renders sample values derived from its fields;
// with `type_id` the definition is a patch to that stored type.
//
// Answers `{ ok, html, css, document, data, render_version, problems }`:
// `html` is the block's markup, `css` the block CSS that ships (scoped),
// `document` a standalone page. A definition with errors is not rendered
// (`ok: false`, problems listed). Block scripts never run in a preview.
// Writes nothing, so a read-only key may call it.

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../lib/api-auth';
import { previewBlockTypeDraft } from '../../../../../../lib/block-type-write';

export const POST: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId, { sideEffectFree: true });
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const body = await request.json().catch(() => null);
  if (body === null) return apiError('Invalid JSON', 400, ctx);
  const outcome = await previewBlockTypeDraft(ctx, body, { allowScript: true });
  return apiResponse(ctx, outcome.body, outcome.status);
};
