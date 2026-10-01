// Session routes for the block template library (editor and Global blocks page).
// GET  — templates with their blocks (the editor previews and inserts them)
// POST — { name, description?, blocks } or { name, description?, from: { page_id, block_id } }

import type { APIRoute } from 'astro';
import { json, requirePermission, requireSiteAccess } from '../../../../../lib/access';
import { BlockTemplateError, createBlockTemplate, listBlockTemplates } from '../../../../../lib/block-templates-store';
import { templateInputFromPage } from '../../../../../lib/block-template-input';

export const GET: APIRoute = async ({ cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  return json({ block_templates: await listBlockTemplates({ orgId: guard.value.owner_org_id, siteId: guard.value.site.id }) });
};

export const POST: APIRoute = async ({ request, cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const check = requirePermission(guard.value, 'write');
  if (!check.ok) return check.response;
  const ctx = { orgId: guard.value.owner_org_id, siteId: guard.value.site.id, versionId: guard.value.versionId };
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'Body must be a JSON object' }, 400);
  try {
    return json({ block_template: await createBlockTemplate(ctx, await templateInputFromPage(ctx, body)) }, 201);
  } catch (error) {
    if (error instanceof BlockTemplateError) return json({ error: error.message }, error.status);
    throw error;
  }
};
