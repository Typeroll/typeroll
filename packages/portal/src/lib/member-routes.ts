// Session guards for the member routes (/api/orgs/{orgId}/members…).

import type { AstroCookies } from 'astro';
import { roleCanManageOrganization, type MemberRole } from '@typeroll/shared';
import { json, requireFullSession, type GuardResult } from './access';
import { memberRole } from './members';

export interface MemberRouteActor { orgId: string; userId: string; role: MemberRole }

/** A signed-in member of the organization the session works in, named by the path. */
export async function requireOrganizationMember(cookies: AstroCookies, orgId: string | undefined): Promise<GuardResult<MemberRouteActor>> {
  const session = await requireFullSession(cookies);
  if (!session.ok) return session;
  // Another organization is refused as missing; switch organizations first.
  if (!orgId || orgId !== session.value.orgId) return { ok: false, response: json({ error: 'Organization not found', code: 'not_found' }, 404) };
  const role = await memberRole(orgId, session.value.userId);
  if (!role) return { ok: false, response: json({ error: 'Only organization members can do this', code: 'member_permission' }, 403) };
  return { ok: true, value: { orgId, userId: session.value.userId, role } };
}

/** An owner or administrator of that organization, whether or not it enforces roles. */
export async function requireMemberManager(cookies: AstroCookies, orgId: string | undefined): Promise<GuardResult<MemberRouteActor>> {
  const member = await requireOrganizationMember(cookies, orgId);
  if (!member.ok) return member;
  if (!roleCanManageOrganization(member.value.role)) {
    const response = json({ error: 'Only organization owners and administrators can manage members', code: 'member_permission' }, 403);
    response.headers.set('Cache-Control', 'no-store');
    return { ok: false, response };
  }
  return member;
}
