// POST /api/orgs/invite/generate
//
// Creates an invite link that another person can redeem at /onboarding to
// join the caller's organization as an editor. Organization owners and admins
// only, whether or not the organization enforces member roles. The invite is
// stored server-side (list and revoke at /api/orgs/invite). The public-API
// equivalent is POST /api/v1/organization/invites.
//
// Body: { ttlDays?: number, max_uses?: number, email?: string }
//   ttlDays  default 7, max 30
//   max_uses default 1 (single use), max 50
//   email    only a person signed in with this address can redeem it
// Returns: { inviteUrl, inviteId, expiresAt, maxUses, email }

import type { APIRoute } from 'astro';
import { json, requireOrganizationOwnerOrAdmin } from '../../../../lib/access';
import { createInvite, InviteRequestError, parseInviteOptions } from '../../../../lib/invite';
import { isFormsSigningConfigured } from '../../../../lib/forms-signing';

const INVITE_REFUSAL = 'Only organization owners and admins can invite people.';

export const POST: APIRoute = async ({ request, cookies }) => {
  const guard = await requireOrganizationOwnerOrAdmin(cookies, INVITE_REFUSAL);
  if (!guard.ok) return guard.response;
  const session = guard.value;

  if (!isFormsSigningConfigured()) {
    return json({ error: 'FORMS_HMAC_SECRET is not configured on this server.' }, 500);
  }

  // Body is optional — defaults are fine.
  let options: ReturnType<typeof parseInviteOptions>;
  try {
    options = parseInviteOptions(await request.json().catch(() => ({})));
  } catch (error) {
    if (error instanceof InviteRequestError) return json({ error: error.message }, 400);
    throw error;
  }
  const invite = await createInvite({
    orgId: session.orgId,
    ttlDays: options.ttlDays,
    maxUses: options.maxUses,
    email: options.email,
    createdBy: { id: session.userId, email: session.email },
  });
  const response = json(invite);
  response.headers.set('Cache-Control', 'no-store');
  return response;
};
