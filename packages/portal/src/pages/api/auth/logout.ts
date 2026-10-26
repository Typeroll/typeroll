import type { APIRoute } from 'astro';
import { clearSession, getSessionIdentity } from '../../../lib/auth';
import { getFirebaseAdminApp } from '../../../lib/firebase-admin';

// Signing out ends the Firebase session server-side, not only in this
// browser: revoking the user's refresh tokens invalidates every session
// cookie minted before now (getSession verifies with checkRevoked), so a
// copied cookie stops working at once instead of living on for up to 14
// days. Firebase has no per-cookie revocation, so this signs the person out
// on their other devices too. Local dev and E2E identities never reach
// Firebase and only have their cookie cleared.
export const POST: APIRoute = async ({ cookies, redirect }) => {
  const identity = await getSessionIdentity(cookies).catch(() => null);
  clearSession(cookies);
  if (identity?.authSource === 'firebase') {
    try {
      const { getAuth } = await import('firebase-admin/auth');
      await getAuth(await getFirebaseAdminApp()).revokeRefreshTokens(identity.userId);
    } catch (error) {
      // The cookie is gone either way; a failed revocation must not keep
      // the person signed in or block the redirect.
      console.error('[auth/logout] refresh token revocation failed:', error instanceof Error ? error.message : error);
    }
  }
  return redirect('/');
};
