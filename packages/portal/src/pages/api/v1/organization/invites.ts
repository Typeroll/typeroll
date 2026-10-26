// GET  /api/v1/organization/invites — the organization's invites, never their
//      links or tokens: id, state (active, used, expired, revoked), uses,
//      expiry, creator and the email address an invite is bound to.
// POST /api/v1/organization/invites — store an invite and return its signed
//      link. Body: { ttl_days?: number, max_uses?: number, email?: string }
//        ttl_days  default 7, max 30
//        max_uses  default 1 (single use), 1–50
//        email     only a person signed in with this address can redeem it
// Revoke with DELETE /api/v1/organization/invites/{inviteId}.
//
// Organization API keys only. Only organization owners and admins can create
// one, so an organization key acts with that authority; a site-scoped key is
// bound to one site and has no say over membership. Redeeming the link still
// requires the invited person to sign in at /onboarding; they join as an
// editor, never as an owner or admin, so the key never grants more than it
// holds. Same options and stored records as POST /api/orgs/invite/generate.

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireAnyApiKey } from '../../../../lib/api-auth';
import { createInvite, InviteRequestError, listInvites, parseInviteOptions } from '../../../../lib/invite';
import { isFormsSigningConfigured } from '../../../../lib/forms-signing';

const ORG_KEY_REQUIRED_FOR_INVITES = 'An organization API key is required to manage organization invites. This key is bound to a single site.';

export const GET: APIRoute = async ({ request }) => {
  const guard = await requireAnyApiKey(request);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  if (ctx.tokenSiteId !== null) return apiError(ORG_KEY_REQUIRED_FOR_INVITES, 403, ctx);
  const response = apiResponse(ctx, { invites: await listInvites(ctx.tokenOrgId) });
  response.headers.set('Cache-Control', 'no-store');
  return response;
};

export const POST: APIRoute = async ({ request }) => {
  const guard = await requireAnyApiKey(request);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  if (ctx.tokenSiteId !== null) return apiError(ORG_KEY_REQUIRED_FOR_INVITES, 403, ctx);
  if (!isFormsSigningConfigured()) {
    return apiError('Invites are unavailable: FORMS_HMAC_SECRET is not configured on this server.', 503, ctx);
  }
  // The body is optional; an empty or absent body uses the defaults.
  const text = await request.text();
  let body: unknown = {};
  if (text.trim()) {
    try { body = JSON.parse(text); } catch { return apiError('Invalid JSON body. Expected { ttl_days?, max_uses?, email? }.', 400, ctx); }
  }
  let options: ReturnType<typeof parseInviteOptions>;
  try {
    options = parseInviteOptions(body);
  } catch (error) {
    if (error instanceof InviteRequestError) return apiError(error.message, 400, ctx);
    throw error;
  }
  const invite = await createInvite({
    orgId: ctx.tokenOrgId,
    ttlDays: options.ttlDays,
    maxUses: options.maxUses,
    email: options.email,
    createdBy: { id: `api_key:${ctx.keyPrefix}` },
  });
  const response = apiResponse(ctx, {
    id: invite.inviteId,
    invite_url: invite.inviteUrl,
    expires_at: invite.expiresAt,
    ttl_days: options.ttlDays,
    max_uses: invite.maxUses,
    email: invite.email,
    role: 'editor',
  }, 201, { ttl_days: options.ttlDays, max_uses: invite.maxUses, email_bound: invite.email !== null });
  response.headers.set('Cache-Control', 'no-store');
  return response;
};
