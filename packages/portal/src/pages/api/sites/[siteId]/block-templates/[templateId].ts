// PATCH  /api/sites/{siteId}/block-templates/{templateId}  { name?, description? , blocks? }
// DELETE /api/sites/{siteId}/block-templates/{templateId}

import type { APIRoute } from 'astro';
import { json, requirePermission, requireSiteAccess } from '../../../../../lib/access';
import { BlockTemplateError, deleteBlockTemplate, updateBlockTemplate } from '../../../../../lib/block-templates-store';

async function guarded(cookies: Parameters<APIRoute>[0]['cookies'], siteId: string | undefined, locals: App.Locals) {
  const guard = await requireSiteAccess(cookies, siteId, locals);
  if (!guard.ok) return { response: guard.response };
  const check = requirePermission(guard.value, 'write');
  if (!check.ok) return { response: check.response };
  return { ctx: { orgId: guard.value.owner_org_id, siteId: guard.value.site.id } };
}

export const PATCH: APIRoute = async ({ request, cookies, params, locals }) => {
  const g = await guarded(cookies, params.siteId, locals);
  if (!g.ctx) return g.response!;
  try {
    return json({ block_template: await updateBlockTemplate(g.ctx, String(params.templateId), await request.json().catch(() => null)) });
  } catch (error) {
    if (error instanceof BlockTemplateError) return json({ error: error.message }, error.status);
    throw error;
  }
};

export const DELETE: APIRoute = async ({ cookies, params, locals }) => {
  const g = await guarded(cookies, params.siteId, locals);
  if (!g.ctx) return g.response!;
  try {
    await deleteBlockTemplate(g.ctx, String(params.templateId));
    return json({ deleted: true });
  } catch (error) {
    if (error instanceof BlockTemplateError) return json({ error: error.message }, error.status);
    throw error;
  }
};
