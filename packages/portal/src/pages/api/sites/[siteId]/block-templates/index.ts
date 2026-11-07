// Session routes for the block template library (editor and Global blocks page).
// GET  — templates with their blocks (the editor previews and inserts them)
// POST — { name, description?, blocks } or { name, description?, from: { page_id, block_id } }
//        → { block_template, design_findings } (hard-coded colours and fonts, non-blocking)

import type { APIRoute } from 'astro';
import { json, requirePermission, requireSiteAccess } from '../../../../../lib/access';
import { BlockTemplateError, createBlockTemplate, listBlockTemplates } from '../../../../../lib/block-templates-store';
import { templateInputFromPage } from '../../../../../lib/block-template-input';
import { blockTemplateDesignFindings } from '../../../../../lib/design-token-audit';

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
    const template = await createBlockTemplate(ctx, await templateInputFromPage(ctx, body));
    // Hard-coded colours and fonts, with the token or role to use instead (non-blocking).
    return json({ block_template: template, design_findings: await blockTemplateDesignFindings(ctx, template) }, 201);
  } catch (error) {
    if (error instanceof BlockTemplateError) return json({ error: error.message }, error.status);
    throw error;
  }
};
