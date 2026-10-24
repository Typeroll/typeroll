import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../../lib/api-auth';
import { PageImportError, importPageFields } from '../../../../../../../lib/page-import';

export const POST: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  if (ctx.permission === 'read' || ctx.extensionIdentity) return apiError('An editor connection is required to import answers', 403);
  if (!params.pageId) return apiError('Missing Page ID', 400);
  const input = await request.json().catch(() => null);
  try {
    const result = await importPageFields(ctx, params.pageId, input, `api-key:${ctx.keyPrefix}`);
    return apiResponse(ctx, result, 200, input);
  } catch (error) {
    if (error instanceof PageImportError) return apiResponse(ctx, { error: error.message, ...error.details as object }, error.status, input);
    throw error;
  }
};
