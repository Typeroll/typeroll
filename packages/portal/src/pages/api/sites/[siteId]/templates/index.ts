import type { APIRoute } from 'astro';
import { json, requireSiteAccess, requirePermission } from '../../../../../lib/access';
import { vstore } from '../../../../../lib/version-store';
import { ContentTypeError } from '../../../../../lib/content-type-service';
import { savePageTemplate, removePageTemplate } from '../../../../../lib/page-template-service';

const handle: APIRoute = async ({ request, cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const { owner_org_id: orgId, site, versionId } = guard.value;
  const ctx = { orgId, siteId: site.id, versionId };
  if (request.method === 'GET') return json({ templates: await vstore.pageTemplates(orgId, site.id, versionId) });
  const permission = requirePermission(guard.value, 'write');
  if (!permission.ok) return permission.response;
  try {
    if (request.method === 'DELETE') {
      const id = new URL(request.url).searchParams.get('id');
      if (!id) throw new ContentTypeError('Template ID is required');
      await removePageTemplate(ctx, id); return json({ ok: true });
    }
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ContentTypeError('JSON object required');
    const create = request.method === 'POST';
    const id = create ? body.name : new URL(request.url).searchParams.get('id');
    if (typeof id !== 'string') throw new ContentTypeError('Template ID is required');
    return json(await savePageTemplate(ctx, id, body, create));
  } catch (error) {
    if (error instanceof ContentTypeError) return json({ error: error.message }, error.status);
    throw error;
  }
};
export const GET = handle;
export const POST = handle;
export const PATCH = handle;
export const DELETE = handle;
