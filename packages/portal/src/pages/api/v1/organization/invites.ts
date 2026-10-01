// POST /api/v1/organization/invites — mint a signed invite link to the
// organization. Body: { ttl_days?: number } (default 7, max 30).
//
// Organization API keys only: in the portal any organization member can
// generate an invite, and an organization key acts for the organization. A
// site-scoped key is bound to one site and has no say over membership.
// Redeeming the link still requires the invited person to sign in at
// /onboarding; they join as an editor, never as an owner or admin, so the
// key never grants more than it holds.

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireAnyApiKey } from '../../../../lib/api-auth';
import { createInviteUrl, parseInviteTtlDays } from '../../../../lib/invite';
import { isFormsSigningConfigured } from '../../../../lib/forms-signing';

export const POST: APIRoute = async ({ request }) => {
  const guard = await requireAnyApiKey(request);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  if (ctx.tokenSiteId !== null) {
    return apiError('An organization API key is required to invite organization members. This key is bound to a single site.', 403, ctx);
  }
  if (!isFormsSigningConfigured()) {
    return apiError('Invites are unavailable: FORMS_HMAC_SECRET is not configured on this server.', 503, ctx);
  }
  // The body is optional; an empty or absent body uses the defaults.
  const text = await request.text();
  let body: unknown = {};
  if (text.trim()) {
    try { body = JSON.parse(text); } catch { return apiError('Invalid JSON body. Expected { ttl_days? }.', 400, ctx); }
  }
  const ttlDays = parseInviteTtlDays(body);
  const { inviteUrl, expiresAt } = createInviteUrl(ctx.tokenOrgId, ttlDays);
  const response = apiResponse(ctx, {
    invite_url: inviteUrl,
    expires_at: expiresAt,
    ttl_days: ttlDays,
    role: 'editor',
  }, 201, { ttl_days: ttlDays });
  response.headers.set('Cache-Control', 'no-store');
  return response;
};
