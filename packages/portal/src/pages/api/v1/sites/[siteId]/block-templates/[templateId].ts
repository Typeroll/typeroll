// GET    /api/v1/sites/{siteId}/block-templates/{templateId}
// PATCH  /api/v1/sites/{siteId}/block-templates/{templateId}  { name?, description?, blocks? }
// DELETE /api/v1/sites/{siteId}/block-templates/{templateId}
// Deleting a template never changes pages that already inserted it.

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../lib/api-auth';
import { BlockTemplateError, deleteBlockTemplate, readBlockTemplate, updateBlockTemplate } from '../../../../../../lib/block-templates-store';

async function handle(run: () => Promise<Response>): Promise<Response> {
  try { return await run(); } catch (error) {
    if (error instanceof BlockTemplateError) return apiError(error.message, error.status);
    throw error;
  }
}

export const GET: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  return handle(async () => apiResponse(guard.value, { block_template: await readBlockTemplate(guard.value, String(params.templateId)) }));
};

export const PATCH: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const body = await request.json().catch(() => null);
  return handle(async () => apiResponse(guard.value, { block_template: await updateBlockTemplate(guard.value, String(params.templateId), body) }));
};

export const DELETE: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  return handle(async () => { await deleteBlockTemplate(guard.value, String(params.templateId)); return apiResponse(guard.value, { deleted: true }); });
};
