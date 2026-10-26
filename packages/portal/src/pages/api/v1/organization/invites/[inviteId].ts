// DELETE /api/v1/organization/invites/{inviteId} — revoke an invite. Its link
// stops working immediately; people who already joined keep their membership
// (remove them separately). Organization API keys only, as for listing and
// creating invites. The portal equivalent is DELETE /api/orgs/invite/{inviteId}.

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireAnyApiKey } from '../../../../../lib/api-auth';
import { revokeInvite } from '../../../../../lib/invite';

export const DELETE: APIRoute = async ({ request, params }) => {
  const guard = await requireAnyApiKey(request);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  if (ctx.tokenSiteId !== null) {
    return apiError('An organization API key is required to manage organization invites. This key is bound to a single site.', 403, ctx);
  }
  const inviteId = params.inviteId;
  // revokeInvite refuses malformed ids before touching the datastore and only
  // updates a record stored under this key's organization.
  const revoked = inviteId ? await revokeInvite(ctx.tokenOrgId, inviteId, { id: `api_key:${ctx.keyPrefix}` }) : false;
  if (!revoked) return apiError('Invite not found', 404, ctx);
  return apiResponse(ctx, { ok: true, id: inviteId });
};
