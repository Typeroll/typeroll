import type { APIRoute } from 'astro';
import { isDevAuthEnabled } from '../../../lib/auth';

// Sets a non-verified `dev` session for local development. Disabled in
// production and whenever Firebase is configured.
export const POST: APIRoute = async ({ cookies, redirect }) => {
  if (!isDevAuthEnabled()) {
    return new Response('Dev session is disabled', { status: 403 });
  }
  cookies.set('typeroll_session', 'dev', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 14 * 24 * 60 * 60,
  });
  return redirect('/app');
};
