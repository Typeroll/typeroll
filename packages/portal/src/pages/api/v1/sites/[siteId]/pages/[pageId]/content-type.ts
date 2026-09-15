import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../../lib/api-auth';
import { changePageContentType } from '../../../../../../../lib/page-type-change';
import { WorkingCopyError } from '../../../../../../../lib/working-copy';

export const POST: APIRoute = async ({ request, params, cookies, locals }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) return apiError('JSON object required', 400);
  try {
    const page = await changePageContentType(ctx, params.pageId!, body, 'agent', 'api');
    return apiResponse(ctx, { page });
  } catch (error) {
    if (error instanceof WorkingCopyError) return apiError(error.message, error.status);
    throw error;
  }
};
