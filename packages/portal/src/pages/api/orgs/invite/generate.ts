// POST /api/orgs/invite/generate
//
// Generates a signed invite URL that another user can redeem at /onboarding
// to join the caller's org. Requires a full session (user must already be
// in an org — only existing members can invite others). The public-API
// equivalent is POST /api/v1/organization/invites.
//
// Body: { ttlDays?: number }  (default 7, max 30)
// Returns: { inviteUrl: string }

import type { APIRoute } from 'astro';
import { json, requireSession } from '../../../../lib/access';
import { createInviteUrl, parseInviteTtlDays } from '../../../../lib/invite';
import { isFormsSigningConfigured } from '../../../../lib/forms-signing';

export const POST: APIRoute = async ({ request, cookies }) => {
  const guard = await requireSession(cookies);
  if (!guard.ok) return guard.response;
  const session = guard.value;

  // Only full (org-having) members can generate invites.
  if (!session.orgId) {
    return json({ error: 'You must belong to an organization to generate an invite.' }, 403);
  }

  if (!isFormsSigningConfigured()) {
    return json({ error: 'FORMS_HMAC_SECRET is not configured on this server.' }, 500);
  }

  // Body is optional — defaults are fine.
  const ttlDays = parseInviteTtlDays(await request.json().catch(() => ({})));
  const { inviteUrl } = createInviteUrl(session.orgId, ttlDays);
  return json({ inviteUrl });
};
