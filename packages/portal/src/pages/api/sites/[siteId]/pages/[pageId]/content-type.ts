import type { APIRoute } from 'astro';
import { json, requireSiteAccess, requirePermission } from '../../../../../../lib/access';
import { changePageContentType } from '../../../../../../lib/page-type-change';
import { WorkingCopyError } from '../../../../../../lib/working-copy';

export const POST: APIRoute = async ({ request, params, cookies, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const permission = requirePermission(guard.value, 'write');
  if (!permission.ok) return permission.response;
  const { owner_org_id, site, versionId, session } = guard.value;
  const ctx = { orgId: owner_org_id, siteId: site.id, versionId };
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'JSON object required' }, 400);
  try {
    const page = await changePageContentType(ctx, params.pageId!, body, 'portal', session.userId ?? 'portal');
    return json({ page });
  } catch (error) {
    if (error instanceof WorkingCopyError) return json({ error: error.message }, error.status);
    throw error;
  }
};
