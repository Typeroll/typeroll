// Cross-org share management for a single site. Admin-only.
//
// GET  — list current shares (including revoked ones, for audit).
// POST — grant a new share. Body: { org_id?, org_slug?, permission?, label? }.
//        Writes the canonical record and the flat-index mirror.
//
// The public-API equivalent is /api/v1/sites/{siteId}/shares; both use
// createSiteShare in lib/shares.

import type { APIRoute } from 'astro';
import { requireSiteAccess, requirePermission, json } from '../../../../../lib/access';
import { createSiteShare, listSharesForSite } from '../../../../../lib/shares';

export const GET: APIRoute = async ({ cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const adminCheck = requirePermission(guard.value, 'admin');
  if (!adminCheck.ok) return adminCheck.response;
  const { site, owner_org_id } = guard.value;
  const shares = await listSharesForSite(owner_org_id, site.id);
  return json({ shares });
};

export const POST: APIRoute = async ({ request, cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const adminCheck = requirePermission(guard.value, 'admin');
  if (!adminCheck.ok) return adminCheck.response;
  const { session, site, owner_org_id } = guard.value;

  const result = await createSiteShare({
    ownerOrgId: owner_org_id,
    siteId: site.id,
    createdBy: session.userId,
    body: await request.json().catch(() => ({})),
  });
  if (!result.ok) return json({ error: result.error }, result.status);
  return json({ share: result.share });
};
