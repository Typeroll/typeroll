import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../lib/api-auth';
import { vstore } from '../../../../../../lib/version-store';
import { ContentTypeError } from '../../../../../../lib/content-type-service';
import { savePageTemplate, removePageTemplate } from '../../../../../../lib/page-template-service';

const handle: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId); if (!guard.ok) return guard.response;
  const ctx = guard.value, id = params.templateId!;
  try {
    if (request.method === 'GET') {
      const template = await vstore.pageTemplate(ctx.orgId, ctx.siteId, ctx.versionId, id);
      return template ? apiResponse(ctx, { template }) : apiError('Template not found', 404);
    }
    if (request.method === 'DELETE') { await removePageTemplate(ctx, id); return apiResponse(ctx, { ok: true }); }
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ContentTypeError('JSON object required');
    return apiResponse(ctx, { template: await savePageTemplate(ctx, id, body) });
  } catch (error) { if (error instanceof ContentTypeError) return apiError(error.message, error.status); throw error; }
};
export const GET = handle;
export const PATCH = handle;
export const DELETE = handle;
