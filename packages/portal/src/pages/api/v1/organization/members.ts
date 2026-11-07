// GET /api/v1/organization/members — the organization's members:
//     { members: [{ id, email, display_name, role, joined_at }] }
// Change a role with PATCH and remove with DELETE
// /api/v1/organization/members/{memberId}.
//
// An organization API key (it acts as an administrator, as for invites) or a
// personal connection of an owner or administrator in the organization named
// by Typeroll-Organization. A site-scoped key is bound to one site and has no
// say over membership. Same records as GET /api/orgs/{orgId}/members.

import type { APIRoute } from 'astro';
import { apiResponse } from '../../../../lib/api-auth';
import { listMembers } from '../../../../lib/members';
import { requireApiMemberActor } from '../../../../lib/member-api';

export const GET: APIRoute = async ({ request }) => {
  const guard = await requireApiMemberActor(request);
  if (!guard.ok) return guard.response;
  const response = apiResponse(guard.value.ctx, { members: await listMembers(guard.value.ctx.tokenOrgId) });
  response.headers.set('Cache-Control', 'no-store');
  return response;
};
