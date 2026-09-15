import type { APIRoute } from 'astro';
import { listContentTypes, saveContentType, removeContentType, ContentTypeError } from '../../../../../../lib/content-type-service';
import { requireApiKey, apiResponse, apiError } from '../../../../../../lib/api-auth';
export const GET: APIRoute = async ({ request, params, cookies, locals }) => { const guard = await requireApiKey(request, params.siteId); if (!guard.ok) return guard.response; const ctx = guard.value; return apiResponse(ctx, { content_types: await listContentTypes(ctx) }); };
export const POST: APIRoute = async ({ request, params, cookies, locals }) => { const guard = await requireApiKey(request, params.siteId); if (!guard.ok) return guard.response; const ctx = guard.value; if (ctx.permission === 'read') return apiError('Write access required', 403);
  try { const body = await request.json().catch(() => null); if (!body || typeof body !== 'object') throw new ContentTypeError('JSON object required');
    const type = await saveContentType(ctx, String(body.name ?? ''), body, true); return apiResponse(ctx, { content_type: type });
  } catch (error) { if (error instanceof ContentTypeError) return apiError(error.message, error.status); throw error; }
};
