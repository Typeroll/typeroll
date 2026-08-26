// POST /api/orgs/invite/generate
//
// Generates a signed invite URL that another user can redeem at /onboarding
// to join the caller's org. Requires a full session (user must already be
// in an org — only existing members can invite others).
//
// Body: { ttlDays?: number }  (default 7, max 30)
// Returns: { inviteUrl: string }

import type { APIRoute } from 'astro';
import { json, requireSession } from '../../../../lib/access';
import { generateInviteToken } from '../../../../lib/invite';
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

  let ttlDays = 7;
  try {
    const body = (await request.json()) as { ttlDays?: unknown };
    if (typeof body.ttlDays === 'number' && body.ttlDays > 0) {
      ttlDays = Math.min(Math.round(body.ttlDays), 30);
    }
  } catch {
    // Body is optional — defaults are fine.
  }

  const token = generateInviteToken(session.orgId, ttlDays * 24 * 60 * 60 * 1000);

  const baseUrl = (process.env.PORTAL_PUBLIC_URL ?? '').replace(/\/$/, '');
  const inviteUrl = `${baseUrl}/onboarding?invite=${encodeURIComponent(token)}`;

  return json({ inviteUrl });
};
