// POST /api/auth/verification-email — send a new email confirmation link to
// the signed-in account. One of the few routes that accepts an unconfirmed
// identity (getSessionIdentity); it can only send Firebase's own message to
// the address already on the account.

import type { APIRoute } from 'astro';
import { getSessionIdentity } from '../../../lib/auth';
import { authClientAddress, limitAuthRequest, readAuthBody, requireAuthOrigin } from '../../../lib/auth-request';
import { safeReturnPath } from '../../../lib/return-path';
import { sendVerificationEmail, verificationContinueUrl } from '../../../lib/email-verification';

export const prerender = false;
const json = (body: unknown, status: number) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
});

/** Per account and per address, so neither one inbox nor one client can be flooded. */
const RESEND_LIMIT_PER_ACCOUNT = 5;
const RESEND_LIMIT_PER_ADDRESS = 30;
const RESEND_WINDOW_MS = 10 * 60_000;

export const POST: APIRoute = async ({ request, cookies, clientAddress }) => {
  const origin = requireAuthOrigin(request);
  if (origin) return origin;
  const identity = await getSessionIdentity(cookies);
  if (!identity) return json({ error: 'Sign in again to continue.' }, 401);
  if (identity.emailVerified) return json({ ok: true, verified: true }, 200);

  const limited = await limitAuthRequest(`verify-email:${identity.userId}`, RESEND_LIMIT_PER_ACCOUNT, RESEND_WINDOW_MS)
    ?? await limitAuthRequest(`verify-email-address:${authClientAddress(request, clientAddress)}`, RESEND_LIMIT_PER_ADDRESS, RESEND_WINDOW_MS);
  if (limited) return limited;

  let next: string | null = null;
  try {
    const text = await readAuthBody(request, 4096);
    next = safeReturnPath(text ? (JSON.parse(text) as { next?: unknown } | null)?.next : null);
  } catch { return json({ error: 'Invalid request.' }, 400); }

  const portalOrigin = new URL(process.env.PORTAL_PUBLIC_URL || request.url).origin;
  try {
    const result = await sendVerificationEmail(identity, verificationContinueUrl(portalOrigin, next));
    if (result === 'throttled') return json({ error: 'Too many attempts. Please wait a few minutes and try again.' }, 429);
    return json({ ok: true, verified: false }, 202);
  } catch (error) {
    console.error('[verification-email] failed:', error instanceof Error ? error.message : 'unknown error');
    return json({ error: 'Could not send a confirmation email. Please try again later.' }, 502);
  }
};
