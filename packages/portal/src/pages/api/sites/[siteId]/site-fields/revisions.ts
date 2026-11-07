// GET  /api/sites/{siteId}/site-fields/revisions           — saved states, newest first
// POST /api/sites/{siteId}/site-fields/revisions { revId } — restore one (site admin)

import type { APIRoute } from 'astro';
import { requireSiteAccess, json, requirePermission } from '../../../../../lib/access';
import { getRevision, listRevisions } from '../../../../../lib/revisions';
import { restoreSiteFieldsRevision, siteFieldsFailureBody, siteFieldsResponse } from '../../../../../lib/site-fields-write';
import type { SiteFields } from '@typeroll/shared';

export const GET: APIRoute = async ({ cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const { site, versionId, owner_org_id } = guard.value;
  const revisions = await listRevisions({ orgId: owner_org_id, siteId: site.id, versionId, kind: 'site_fields', resourceIds: ['default'] });
  return json({ revisions });
};

export const POST: APIRoute = async ({ request, cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const adminCheck = requirePermission(guard.value, 'admin');
  if (!adminCheck.ok) return adminCheck.response;
  const { session, site, versionId, owner_org_id, permission } = guard.value;
  const { revId } = ((await request.json().catch(() => ({}))) ?? {}) as { revId?: string };
  if (!revId || typeof revId !== 'string') return json({ error: 'revId required' }, 400);
  const ctx = { orgId: owner_org_id, siteId: site.id, versionId };
  const rev = await getRevision({ ...ctx, kind: 'site_fields', resourceIds: ['default'], revId });
  if (!rev) return json({ error: 'Revision not found' }, 404);
  try {
    const siteFields = await restoreSiteFieldsRevision(ctx, rev.doc as Partial<SiteFields>, revId, { permission, updatedBy: session.email ?? 'unknown' });
    return json({ ok: true, ...siteFieldsResponse(siteFields, permission) });
  } catch (error) {
    const refused = siteFieldsFailureBody(error);
    if (!refused) throw error;
    return json(refused.body, refused.status);
  }
};
