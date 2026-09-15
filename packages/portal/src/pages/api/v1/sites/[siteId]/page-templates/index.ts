import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../lib/api-auth';
import { vstore } from '../../../../../../lib/version-store';
import { ContentTypeError } from '../../../../../../lib/content-type-service';
import { savePageTemplate } from '../../../../../../lib/page-template-service';

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
    if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.name !== 'string') throw new ContentTypeError('Template name and JSON object required');
    return apiResponse(ctx, { template: await savePageTemplate(ctx, body.name, body, true) });
  } catch (error) { if (error instanceof ContentTypeError) return apiError(error.message, error.status); throw error; }
};
