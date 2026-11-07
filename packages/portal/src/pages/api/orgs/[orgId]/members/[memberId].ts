// PATCH  /api/orgs/{orgId}/members/{memberId}  body: { role } → { member }
// DELETE /api/orgs/{orgId}/members/{memberId}                → { removed: true, id }
//
// Owners and administrators change roles (owner, admin, builder, editor) and
// remove members. Only an owner makes someone an owner or changes or removes
// an owner, and the last owner can be neither demoted nor removed
// (409 last_owner). Anyone may remove themselves (leave), except the last
// owner. Same rules as /api/v1/organization/members (lib/members.ts).

import type { APIRoute } from 'astro';
import { json } from '../../../../../lib/access';
import { memberFailureBody, removeMember, updateMemberRole } from '../../../../../lib/members';
import { requireMemberManager, requireOrganizationMember } from '../../../../../lib/member-routes';

export const PATCH: APIRoute = async ({ cookies, params, request }) => {
  const guard = await requireMemberManager(cookies, params.orgId);
  if (!guard.ok) return guard.response;
  const body = (await request.json().catch(() => null)) as { role?: unknown } | null;
  if (!body || typeof body !== 'object') return json({ error: 'Send { role }', code: 'member_role_invalid' }, 400);
  try {
    const member = await updateMemberRole(guard.value.orgId, { userId: guard.value.userId, role: guard.value.role }, params.memberId ?? '', body.role);
    return json({ member });
  } catch (error) {
    const refused = memberFailureBody(error);
    if (!refused) throw error;
    return json(refused.body, refused.status);
  }
};

export const DELETE: APIRoute = async ({ cookies, params }) => {
  // Leaving needs only membership; removing someone else is checked in removeMember.
  const guard = await requireOrganizationMember(cookies, params.orgId);
  if (!guard.ok) return guard.response;
  try {
    return json(await removeMember(guard.value.orgId, { userId: guard.value.userId, role: guard.value.role }, params.memberId ?? ''));
  } catch (error) {
    const refused = memberFailureBody(error);
    if (!refused) throw error;
    return json(refused.body, refused.status);
  }
};
