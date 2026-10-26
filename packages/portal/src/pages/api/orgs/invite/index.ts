// GET /api/orgs/invite — the organization's invites (never their tokens):
// state (active, used, expired, revoked), uses, expiry and creator.
// Organization owners and admins only. Revoke with
// DELETE /api/orgs/invite/{inviteId}.

import type { APIRoute } from 'astro';
import { json, requireOrganizationOwnerOrAdmin } from '../../../../lib/access';
import { listInvites } from '../../../../lib/invite';

export const GET: APIRoute = async ({ cookies }) => {
  const guard = await requireOrganizationOwnerOrAdmin(cookies, 'Only organization owners and admins can manage invites.');
  if (!guard.ok) return guard.response;
  const response = json({ invites: await listInvites(guard.value.orgId) });
  response.headers.set('Cache-Control', 'no-store');
  return response;
};
