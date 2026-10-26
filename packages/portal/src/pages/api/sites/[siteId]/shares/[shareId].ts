// Manage a single existing share — admins of the owning organization only.
//
// PATCH  — change permission level and/or label.
// DELETE — revoke (soft-deletes canonical, hard-deletes index entry).
//
// The public-API equivalent is /api/v1/sites/{siteId}/shares/{shareId}.

import type { APIRoute } from 'astro';
import { requireSiteAccess, requireOwnerPermission, json } from '../../../../../lib/access';
import { parseShareUpdate, revokeShare, updateShare } from '../../../../../lib/shares';

const OWNER_REQUIRED = 'Only the owning organization can change who this site is shared with';

export const PATCH: APIRoute = async ({ request, cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const adminCheck = requireOwnerPermission(guard.value, 'admin', OWNER_REQUIRED);
  if (!adminCheck.ok) return adminCheck.response;
  const { site, owner_org_id } = guard.value;
  const { shareId } = params;
  if (!shareId) return json({ error: 'Missing shareId' }, 400);

  const patch = parseShareUpdate(await request.json().catch(() => ({})));
  if ('error' in patch) return json({ error: patch.error }, 400);

  const updated = await updateShare(owner_org_id, site.id, shareId, patch);
  if (!updated) return json({ error: 'Share not found' }, 404);
  return json({ share: updated });
};

export const DELETE: APIRoute = async ({ cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const adminCheck = requireOwnerPermission(guard.value, 'admin', OWNER_REQUIRED);
  if (!adminCheck.ok) return adminCheck.response;
  const { site, owner_org_id } = guard.value;
  const { shareId } = params;
  if (!shareId) return json({ error: 'Missing shareId' }, 400);

  const result = await revokeShare(owner_org_id, site.id, shareId);
  if (!result) return json({ error: 'Share not found' }, 404);
  return json({ ok: true });
};
