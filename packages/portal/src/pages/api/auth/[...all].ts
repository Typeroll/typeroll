// Better Auth endpoints (sign-in, sign-up, GitHub, email confirmation,
// password reset, sessions). Static routes beside this file (logout,
// dev-session, e2e-session, verification-*) take precedence.
import type { APIRoute } from 'astro';
import { getPortalAuth } from '../../../lib/identity/portal-auth';

export const prerender = false;

export const ALL: APIRoute = async ({ request }) => {
  const auth = getPortalAuth();
  if (!auth) return new Response(JSON.stringify({ error: 'Sign-in is currently unavailable.' }), {
    status: 503, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
  const response = await auth.handler(request);
  response.headers.set('Cache-Control', 'no-store');
  return response;
};
