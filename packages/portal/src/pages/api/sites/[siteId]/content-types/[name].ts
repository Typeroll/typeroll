import type { APIRoute } from 'astro';
import { listContentTypes, saveContentType, removeContentType, ContentTypeError } from '../../../../../lib/content-type-service';
import { requireSiteAccess, requirePermission, json } from '../../../../../lib/access';
export const GET: APIRoute = async ({ request, params, cookies, locals }) => { const guard = await requireSiteAccess(cookies, params.siteId, locals); if (!guard.ok) return guard.response; const { owner_org_id: orgId, site, versionId } = guard.value; const ctx = { orgId, siteId: site.id, versionId };
  const type = (await listContentTypes(ctx)).find(type => type.id === params.name);
  if (!type) return new Response('Content type not found', { status: 404 }); return json({ content_type: type });
};
export const PUT: APIRoute = async ({ request, params, cookies, locals }) => { const guard = await requireSiteAccess(cookies, params.siteId, locals); if (!guard.ok) return guard.response; const { owner_org_id: orgId, site, versionId } = guard.value; const ctx = { orgId, siteId: site.id, versionId }; const check = requirePermission(guard.value, 'write'); if (!check.ok) return check.response;
  try { const body = await request.json().catch(() => null); const type = await saveContentType(ctx, params.name ?? '', body); return json({ content_type: type }); } catch (error) { if (error instanceof ContentTypeError) return json({ error: error.message }, error.status); throw error; }
};
export const DELETE: APIRoute = async ({ request, params, cookies, locals }) => { const guard = await requireSiteAccess(cookies, params.siteId, locals); if (!guard.ok) return guard.response; const { owner_org_id: orgId, site, versionId } = guard.value; const ctx = { orgId, siteId: site.id, versionId }; const check = requirePermission(guard.value, 'write'); if (!check.ok) return check.response;
  try { await removeContentType(ctx, params.name ?? ''); return json({ ok: true }); } catch (error) { if (error instanceof ContentTypeError) return json({ error: error.message }, error.status); throw error; }
};
