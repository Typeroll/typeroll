// DELETE /api/orgs/invite/{inviteId} — revoke an invite. Its link stops
// working immediately; people who already joined keep their membership
// (remove them separately). Organization owners and admins only.

import type { APIRoute } from 'astro';
import { json, requireOrganizationOwnerOrAdmin } from '../../../../lib/access';
import { revokeInvite } from '../../../../lib/invite';

export const DELETE: APIRoute = async ({ cookies, params }) => {
  const guard = await requireOrganizationOwnerOrAdmin(cookies, 'Only organization owners and admins can manage invites.');
  if (!guard.ok) return guard.response;
  const session = guard.value;
  const revoked = params.inviteId
    ? await revokeInvite(session.orgId, params.inviteId, { id: session.userId, email: session.email })
    : false;
  if (!revoked) return json({ error: 'Invite not found' }, 404);
  return json({ ok: true });
};
