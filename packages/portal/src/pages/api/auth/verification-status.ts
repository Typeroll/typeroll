// POST /api/auth/verification-status — asked automatically by "Check your
// email". Sessions are read from the store on every request, so the identity
// already reflects a confirmation made in another tab or browser.

import type { APIRoute } from 'astro';
import { getSessionIdentity } from '../../../lib/auth';
import { limitAuthRequest, requireAuthOrigin } from '../../../lib/auth-request';

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
  const limited = await limitAuthRequest(`verify-status:${identity.userId}`, 120, 10 * 60_000);
  if (limited) return limited;
  return json({ ok: true, verified: false }, 200);
};
