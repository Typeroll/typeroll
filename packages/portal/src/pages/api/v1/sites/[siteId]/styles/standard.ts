// POST /api/v1/sites/{siteId}/styles/standard  body: { overwrite?: boolean }
//
// Adds the platform's standard styles (body, H1–H6, link, lead, eyebrow,
// small, quote, buttons, section) that the site is missing, matched by role.
// `overwrite: true` resets the standard roles to the platform defaults.
// Changes how the site looks; agents should ask before overwriting.

import type { APIRoute } from 'astro';
import { apiResponse, requireApiKey } from '../../../../../../lib/api-auth';
import { applyStandardStyles, StyleError } from '../../../../../../lib/site-styles-store';

export const POST: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const body = (await request.json().catch(() => ({}))) as { overwrite?: unknown } | null;
  try {
    const result = await applyStandardStyles(ctx, { overwrite: body?.overwrite === true });
    return apiResponse(ctx, result, 200, body);
  } catch (error) {
    if (error instanceof StyleError) return apiResponse(ctx, { error: error.message, errors: error.errors }, error.status, body);
    throw error;
  }
};
