import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../../lib/api-auth';
import { PageImportError, readPageAuthority } from '../../../../../../../lib/page-import';

export const GET: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  if (ctx.permission === 'read' || ctx.extensionIdentity) return apiError('An editor connection is required to inspect answer authority', 403);
  if (!params.pageId) return apiError('Missing Page ID', 400);
  try {
    let requested: unknown;
    try { requested = JSON.parse(new URL(request.url).searchParams.get('paths') ?? 'null'); }
    catch { return apiError('paths must be a JSON array of schema leaf paths', 400); }
    const result = await readPageAuthority(ctx, params.pageId, requested);
    const response = apiResponse(ctx, result);
    response.headers.set('Cache-Control', 'private, no-store');
    return response;
  } catch (error) {
    if (error instanceof PageImportError) return apiError(error.message, error.status);
    throw error;
  }
};
