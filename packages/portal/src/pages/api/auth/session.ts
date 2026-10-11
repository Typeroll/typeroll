import type { APIRoute } from 'astro';
import { isFirebaseConfigured, setSessionFromIdToken } from '../../../lib/auth';
import { authClientAddress, limitAuthRequest, requireAuthOrigin, readAuthBody } from '../../../lib/auth-request';

export const prerender = false;
const json = (body: unknown, status: number) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
});

export const POST: APIRoute = async ({ request, cookies, clientAddress }) => {
  const origin = requireAuthOrigin(request);
  if (origin) return origin;
  const limited = await limitAuthRequest(`session:${authClientAddress(request, clientAddress)}`);
  if (limited) return limited;
  if (!isFirebaseConfigured()) return json({ error: 'Sign-in is currently unavailable.' }, 503);
  let body: unknown;
  try {
    const text = await readAuthBody(request, 16_384);
    if (text.length > 16_384) return json({ error: 'Invalid sign-in request.' }, 400);
    body = JSON.parse(text);
  } catch { return json({ error: 'Invalid sign-in request.' }, 400); }
  const idToken = (body as { idToken?: unknown } | null)?.idToken;
  if (typeof idToken !== 'string' || !idToken || idToken.length > 12_000) return json({ error: 'Invalid sign-in request.' }, 400);
  try {
    const session = await setSessionFromIdToken(cookies, idToken);
    return json({ ok: true, session }, 200);
  } catch {
    return json({ error: 'Could not finish signing in. Please sign in again.' }, 401);
  }
};
