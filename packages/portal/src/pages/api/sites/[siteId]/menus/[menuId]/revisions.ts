// GET  /api/sites/{siteId}/menus/{menuId}/revisions          — saved states, newest first
// POST /api/sites/{siteId}/menus/{menuId}/revisions { revId } — restore one (a save)

import type { APIRoute } from 'astro';
import { requireSiteAccess, json, requirePermission } from '../../../../../../lib/access';
import { vstore } from '../../../../../../lib/version-store';
import { listRevisions, getRevision } from '../../../../../../lib/revisions';
import { MenuSaveError, restoreMenuRevision } from '../../../../../../lib/menu-write';
import { pathParam } from '../../../../../../lib/path-param';
import type { Menu } from '@typeroll/shared';

export const GET: APIRoute = async ({ cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const { site, versionId, owner_org_id } = guard.value;
  const menuId = pathParam(params.menuId);
  if (!menuId) return json({ error: 'Missing menuId' }, 400);
  const revisions = await listRevisions({ orgId: owner_org_id, siteId: site.id, versionId, kind: 'menu', resourceIds: [menuId] });
  return json({ revisions });
};

export const POST: APIRoute = async ({ request, cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const writeCheck = requirePermission(guard.value, 'write');
  if (!writeCheck.ok) return writeCheck.response;
  const { session, site, versionId, owner_org_id } = guard.value;
  const menuId = pathParam(params.menuId);
  if (!menuId) return json({ error: 'Missing menuId' }, 400);
  const { revId } = ((await request.json().catch(() => ({}))) ?? {}) as { revId?: string };
  if (!revId || typeof revId !== 'string') return json({ error: 'revId required' }, 400);
  const ctx = { orgId: owner_org_id, siteId: site.id, versionId };
  if (!(await vstore.menu(owner_org_id, site.id, versionId, menuId))) return json({ error: 'Not found' }, 404);
  const rev = await getRevision({ ...ctx, kind: 'menu', resourceIds: [menuId], revId });
  if (!rev) return json({ error: 'Revision not found' }, 404);
  try {
    const menu = await restoreMenuRevision(ctx, menuId, rev.doc as Partial<Menu>, revId, session.email ?? 'unknown');
    return json({ ok: true, menu });
  } catch (error) {
    if (error instanceof MenuSaveError) return json({ error: error.message }, error.status);
    throw error;
  }
};
