import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../lib/api-auth';
import { vstore } from '../../../../../../lib/version-store';
import { ContentTypeError } from '../../../../../../lib/content-type-service';
import { newPageTemplateId, savePageTemplate } from '../../../../../../lib/page-template-service';

export const GET: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId); if (!guard.ok) return guard.response;
  const ctx = guard.value;
  return apiResponse(ctx, { templates: await vstore.pageTemplates(ctx.orgId, ctx.siteId, ctx.versionId) });
};
export const POST: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId); if (!guard.ok) return guard.response;
  const ctx = guard.value;
  try {
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ContentTypeError('JSON object with a template name or id required');
    const { id, input } = await newPageTemplateId(ctx, body);
    return apiResponse(ctx, { template: await savePageTemplate(ctx, id, input, true) });
  } catch (error) { if (error instanceof ContentTypeError) return apiError(error.message, error.status, ctx, error.code ? { code: error.code } : undefined); throw error; }
};
