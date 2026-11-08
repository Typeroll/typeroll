// GET /api/orgs/{orgId}/members — the organization's members:
//     { members: [{ id, email, display_name, role, joined_at }], self: { id, role } }
//
// The organization in the path must be the one the session works in (switch
// with /api/orgs/switch). Owners and administrators only, whether or not the
// organization enforces roles, like invites: the list holds people's email
// addresses. Change a role with PATCH and remove with DELETE
// /api/orgs/{orgId}/members/{memberId}. The public API equivalent is
// /api/v1/organization/members.

import type { APIRoute } from 'astro';
import { json } from '../../../../../lib/access';
import { listMembers } from '../../../../../lib/members';
import { requireMemberManager } from '../../../../../lib/member-routes';

export const GET: APIRoute = async ({ cookies, params }) => {
  const guard = await requireMemberManager(cookies, params.orgId);
  if (!guard.ok) return guard.response;
  const response = json({ members: await listMembers(guard.value.orgId), self: { id: guard.value.userId, role: guard.value.role } });
  response.headers.set('Cache-Control', 'no-store');
  return response;
};
