// POST /api/auth/verification-status — "I've confirmed my email". Re-checks
// the account in Firebase and, once the address is confirmed, replaces the
// pending session cookie with one carrying `email_verified: true`.

import type { APIRoute } from 'astro';
import { getSessionIdentity } from '../../../lib/auth';
import { limitAuthRequest, requireAuthOrigin } from '../../../lib/auth-request';
import { confirmEmailVerification } from '../../../lib/email-verification';

export const prerender = false;
const json = (body: unknown, status: number) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
});

export const POST: APIRoute = async ({ request, cookies }) => {
  const origin = requireAuthOrigin(request);
  if (origin) return origin;
  const identity = await getSessionIdentity(cookies);
  if (!identity) return json({ error: 'Sign in again to continue.' }, 401);
  if (identity.emailVerified) return json({ ok: true, verified: true }, 200);
  const limited = await limitAuthRequest(`verify-status:${identity.userId}`, 30, 10 * 60_000);
  if (limited) return limited;
  try {
    return json({ ok: true, verified: await confirmEmailVerification(cookies, identity) }, 200);
  } catch (error) {
    console.error('[verification-status] failed:', error instanceof Error ? error.message : 'unknown error');
    return json({ error: 'Could not check your email confirmation. Please try again shortly.' }, 502);
  }
};
