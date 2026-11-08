// PATCH  /api/v1/organization/members/{memberId}  body: { role } → { member }
// DELETE /api/v1/organization/members/{memberId}                → { removed: true, id }
//
// role is owner, admin, builder or editor. Only an owner (a personal
// connection of one) makes someone an owner or changes or removes an owner;
// an organization API key acts as an administrator and cannot. The last owner
// can be neither demoted nor removed (409 last_owner). Same rules as the
// portal (lib/members.ts).

import type { APIRoute } from 'astro';
import { apiError, apiResponse } from '../../../../../lib/api-auth';
import { memberFailureBody, removeMember, updateMemberRole } from '../../../../../lib/members';
import { requireApiMemberActor } from '../../../../../lib/member-api';

function failure(error: unknown, ctx: Parameters<typeof apiError>[2]): Response {
  const refused = memberFailureBody(error);
  if (!refused) throw error;
  return apiError(refused.body.error, refused.status, ctx, { code: refused.body.code });
}

export const PATCH: APIRoute = async ({ request, params }) => {
  const guard = await requireApiMemberActor(request);
  if (!guard.ok) return guard.response;
  const { ctx, actor } = guard.value;
  const body = (await request.json().catch(() => null)) as { role?: unknown } | null;
  if (!body || typeof body !== 'object') return apiError('Send { role }', 400, ctx, { code: 'member_role_invalid' });
  try {
    return apiResponse(ctx, { member: await updateMemberRole(ctx.tokenOrgId, actor, params.memberId ?? '', body.role) }, 200, { role: body.role });
  } catch (error) { return failure(error, ctx); }
};

export const DELETE: APIRoute = async ({ request, params }) => {
  const guard = await requireApiMemberActor(request);
  if (!guard.ok) return guard.response;
  const { ctx, actor } = guard.value;
  try {
    return apiResponse(ctx, await removeMember(ctx.tokenOrgId, actor, params.memberId ?? ''));
  } catch (error) { return failure(error, ctx); }
};
