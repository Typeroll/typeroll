// GET  /api/v1/sites/{siteId}/block-templates — list block templates (summary)
// POST /api/v1/sites/{siteId}/block-templates — create one
//   { name, description?, id?, blocks }                  from a block tree, or
//   { name, description?, id?, from: { page_id, block_id } } from a page block (draft)
//
// Block templates are copy-in section starters, stored per site (not per
// version). Insert one with POST .../pages/{pageId}/blocks/insert-template.

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../lib/api-auth';
import { BlockTemplateError, createBlockTemplate, listBlockTemplates } from '../../../../../../lib/block-templates-store';
import { templateInputFromPage } from '../../../../../../lib/block-template-input';

export const GET: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const templates = await listBlockTemplates(ctx);
  return apiResponse(ctx, { block_templates: templates.map(({ blocks, ...rest }) => ({ ...rest, block_count: blocks.length, top_level_types: blocks.map(block => block.type) })) });
};

export const POST: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return apiError('Body must be a JSON object');
  try {
    const input = await templateInputFromPage(ctx, body);
    return apiResponse(ctx, { block_template: await createBlockTemplate(ctx, input) }, 201);
  } catch (error) {
    if (error instanceof BlockTemplateError) return apiError(error.message, error.status);
    throw error;
  }
};
