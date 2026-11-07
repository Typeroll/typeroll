// API guard for /api/v1/organization/members…: who acts, with which role.

import { apiError, requireAnyApiKey, type ApiContext, type GuardResult } from './api-auth';
import { memberRole, type MemberActor } from './members';

const ORG_KEY_REQUIRED = 'An organization API key or a personal connection is required to manage organization members. This key is bound to a single site.';

/**
 * An organization API key acts as an administrator; a personal connection
 * acts with the person's own role (requireAnyApiKey already limits personal
 * root requests to owners and administrators).
 */
export async function requireApiMemberActor(request: Request): Promise<GuardResult<{ ctx: ApiContext; actor: MemberActor }>> {
  const guard = await requireAnyApiKey(request);
  if (!guard.ok) return guard;
  const ctx = guard.value;
  if (ctx.tokenSiteId !== null) return { ok: false, response: apiError(ORG_KEY_REQUIRED, 403, ctx) };
  if (ctx.personalUserId) {
    const role = await memberRole(ctx.tokenOrgId, ctx.personalUserId);
    if (!role) return { ok: false, response: apiError('Only organization members can do this', 403, ctx, { code: 'member_permission' }) };
    return { ok: true, value: { ctx, actor: { userId: ctx.personalUserId, role } } };
  }
  return { ok: true, value: { ctx, actor: { role: 'admin' } } };
}
