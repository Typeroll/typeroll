import type { APIRoute } from 'astro';
import { listContentTypes, saveContentType, removeContentType, ContentTypeError } from '../../../../../../lib/content-type-service';
import { requireApiKey, apiResponse, apiError } from '../../../../../../lib/api-auth';
export const GET: APIRoute = async ({ request, params, cookies, locals }) => { const guard = await requireApiKey(request, params.siteId); if (!guard.ok) return guard.response; const ctx = guard.value;
  const type = (await listContentTypes(ctx)).find(type => type.id === params.name);
  // A 404 here is exactly when the caller most needs to know which site was
  // consulted: the content type may well exist on the one they meant.
  if (!type) return apiError('Content type not found', 404, ctx); return apiResponse(ctx, { content_type: type });
};
export const PATCH: APIRoute = async ({ request, params, cookies, locals }) => { const guard = await requireApiKey(request, params.siteId); if (!guard.ok) return guard.response; const ctx = guard.value; if (ctx.permission === 'read') return apiError('Write access required', 403);
  try { const body = await request.json().catch(() => null); const type = await saveContentType(ctx, params.name ?? '', body); return apiResponse(ctx, { content_type: type }); } catch (error) { if (error instanceof ContentTypeError) return apiError(error.message, error.status); throw error; }
};
export const DELETE: APIRoute = async ({ request, params, cookies, locals }) => { const guard = await requireApiKey(request, params.siteId); if (!guard.ok) return guard.response; const ctx = guard.value; if (ctx.permission === 'read') return apiError('Write access required', 403);
  try { await removeContentType(ctx, params.name ?? ''); return apiResponse(ctx, { ok: true }); } catch (error) { if (error instanceof ContentTypeError) return apiError(error.message, error.status); throw error; }
};
