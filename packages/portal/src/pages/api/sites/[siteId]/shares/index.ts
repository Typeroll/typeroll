// Cross-org share management for a single site. Admin-only.
//
// GET  — list current shares (including revoked ones, for audit).
// POST — grant a new share. Body: { org_id?, org_slug?, permission?, label? }.
//        Writes the canonical record and the flat-index mirror.

import type { APIRoute } from 'astro';
import { randomUUID } from 'node:crypto';
import { requireSiteAccess, requirePermission, json } from '../../../../../lib/access';
import {
  listSharesForSite,
  resolveTargetOrg,
  writeShare,
} from '../../../../../lib/shares';
import type { SharePermission, SiteShare } from '@typeroll/shared';

const VALID_PERMISSIONS: SharePermission[] = ['read', 'write', 'admin'];

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

  const body = (await request.json().catch(() => ({}))) as {
    org_id?: string;
    org_slug?: string;
    permission?: string;
    label?: string;
  };

  const permission = (body.permission ?? 'write') as SharePermission;
  if (!VALID_PERMISSIONS.includes(permission)) {
    return json({ error: `permission must be one of: ${VALID_PERMISSIONS.join(', ')}` }, 400);
  }

  const target = await resolveTargetOrg({ org_id: body.org_id, org_slug: body.org_slug });
  if ('error' in target) return json({ error: target.error }, 400);

  // Sharing with yourself is meaningless — the owning org already has
  // implicit admin access.
  if (target.orgId === owner_org_id) {
    return json({ error: 'Cannot share a site with its owning organization' }, 400);
  }

  // Avoid duplicate active shares to the same recipient. An admin can update
  // an existing share via PATCH; creating a second one just confuses the
  // listing view.
  const existing = await listSharesForSite(owner_org_id, site.id);
  if (existing.some((s) => s.shared_with_org_id === target.orgId && !s.revoked_at)) {
    return json({ error: 'This organization already has access to this site' }, 409);
  }

  const share: SiteShare = {
    id: randomUUID(),
    site_id: site.id,
    owner_org_id,
    shared_with_org_id: target.orgId,
    permission,
    created_at: Date.now(),
    created_by: session.userId,
    label: body.label?.trim() || undefined,
  };
  await writeShare(share);
  return json({ share });
};
