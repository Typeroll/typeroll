// Manage a single existing share — admin-only.
//
// PATCH  — change permission level and/or label.
// DELETE — revoke (soft-deletes canonical, hard-deletes index entry).

import type { APIRoute } from 'astro';
import { requireSiteAccess, requirePermission, json } from '../../../../../lib/access';
import { revokeShare, updateShare } from '../../../../../lib/shares';
import type { SharePermission } from '@typeroll/shared';

const VALID_PERMISSIONS: SharePermission[] = ['read', 'write', 'admin'];

export const PATCH: APIRoute = async ({ request, cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const adminCheck = requirePermission(guard.value, 'admin');
  if (!adminCheck.ok) return adminCheck.response;
  const { site, owner_org_id } = guard.value;
  const { shareId } = params;
  if (!shareId) return json({ error: 'Missing shareId' }, 400);

  const body = (await request.json().catch(() => ({}))) as {
    permission?: string;
    label?: string;
  };

  const permission = body.permission as SharePermission | undefined;
  if (permission !== undefined && !VALID_PERMISSIONS.includes(permission)) {
    return json({ error: `permission must be one of: ${VALID_PERMISSIONS.join(', ')}` }, 400);
  }

  if (!permission && body.label === undefined) {
    return json({ error: 'permission or label required' }, 400);
  }

  const updated = await updateShare(owner_org_id, site.id, shareId, {
    permission,
    label: body.label,
  });
  if (!updated) return json({ error: 'Share not found' }, 404);
  return json({ share: updated });
};

export const DELETE: APIRoute = async ({ cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const adminCheck = requirePermission(guard.value, 'admin');
  if (!adminCheck.ok) return adminCheck.response;
  const { site, owner_org_id } = guard.value;
  const { shareId } = params;
  if (!shareId) return json({ error: 'Missing shareId' }, 400);

  const result = await revokeShare(owner_org_id, site.id, shareId);
  if (!result) return json({ error: 'Share not found' }, 404);
  return json({ ok: true });
};
