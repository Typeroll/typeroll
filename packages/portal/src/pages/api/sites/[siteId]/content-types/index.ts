import type { APIRoute } from 'astro';
import { listContentTypes, saveContentType, removeContentType, ContentTypeError } from '../../../../../lib/content-type-service';
import { requireSiteAccess, requirePermission, json } from '../../../../../lib/access';
export const GET: APIRoute = async ({ request, params, cookies, locals }) => { const guard = await requireSiteAccess(cookies, params.siteId, locals); if (!guard.ok) return guard.response; const { owner_org_id: orgId, site, versionId } = guard.value; const ctx = { orgId, siteId: site.id, versionId }; return json({ content_types: await listContentTypes(ctx) }); };
export const POST: APIRoute = async ({ request, params, cookies, locals }) => { const guard = await requireSiteAccess(cookies, params.siteId, locals); if (!guard.ok) return guard.response; const { owner_org_id: orgId, site, versionId } = guard.value; const ctx = { orgId, siteId: site.id, versionId }; const check = requirePermission(guard.value, 'write'); if (!check.ok) return check.response;
  try { const body = await request.json().catch(() => null); if (!body || typeof body !== 'object') throw new ContentTypeError('JSON object required');
    const type = await saveContentType(ctx, String(body.name ?? ''), body, true); return json({ content_type: type });
  } catch (error) { if (error instanceof ContentTypeError) return json({ error: error.message }, error.status); throw error; }
};
