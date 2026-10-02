import type { APIRoute } from 'astro';
import { isDevAuthEnabled } from '../../../lib/auth';
import { safeReturnPath } from '../../../lib/return-path';

// Sets a non-verified `dev` session for local development. Disabled in
// production and whenever Firebase is configured.
export const POST: APIRoute = async ({ cookies, redirect, request }) => {
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
  let next: string | null = null;
  try { next = safeReturnPath((await request.formData()).get('next')); } catch { /* No form body. */ }
  return redirect(next ?? '/app');
};
