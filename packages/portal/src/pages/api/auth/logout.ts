import type { APIRoute } from 'astro';
import { clearSession, revokeCurrentSession } from '../../../lib/auth';

// Sign-out revokes this browser's Firebase sign-in on the server, so a copy of
// the cookie stops working as well, then deletes the cookie. Other devices and
// OAuth/MCP connections stay signed in.
export const POST: APIRoute = async ({ cookies, redirect }) => {
  try {
    await revokeCurrentSession(cookies);
  } catch (error) {
    // The browser is still signed out; only copies of the cookie stay valid
    // until they expire. Log without cookie or identity details.
    console.error('[logout] session revocation failed:', error instanceof Error ? error.message : 'unknown error');
  }
  clearSession(cookies);
  return redirect('/');
};
