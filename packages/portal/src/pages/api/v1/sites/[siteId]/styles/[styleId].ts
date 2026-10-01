// GET    /api/v1/sites/{siteId}/styles/{styleId}
// PATCH  /api/v1/sites/{siteId}/styles/{styleId} — base, hover and each
//        breakpoint under `at` merge per property (null removes one)
// DELETE /api/v1/sites/{siteId}/styles/{styleId}

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../lib/api-auth';
import { deleteStyle, readStyles, StyleError, updateStyle } from '../../../../../../lib/site-styles-store';

export const GET: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const style = (await readStyles(ctx)).styles.find(item => item.id === params.styleId);
  if (!style) return apiError(`Style "${params.styleId}" not found`, 404);
  return apiResponse(ctx, { style });
};

export const PATCH: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const body = await request.json().catch(() => null);
  try {
    return apiResponse(ctx, { style: await updateStyle(ctx, params.styleId ?? '', body) }, 200, body);
  } catch (error) {
    if (error instanceof StyleError) return apiResponse(ctx, { error: error.message, errors: error.errors }, error.status, body);
    throw error;
  }
};

export const DELETE: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  try {
    await deleteStyle(ctx, params.styleId ?? '');
    return apiResponse(ctx, { ok: true, deleted: params.styleId });
  } catch (error) {
    if (error instanceof StyleError) return apiError(error.message, error.status);
    throw error;
  }
};
