// Email confirmation for accounts whose Firebase identity has no confirmed
// address (new password sign-ups, GitHub sign-ins, older accounts).
//
// The browser signs out of Firebase right after the session exchange, so the
// "Check your email" page works server-side for the identity in the pending
// session cookie: Firebase mints an ID token for that user (custom token
// exchange, the same path as the rolling session refresh) and sends its own
// confirmation email, or re-mints the session once the address is confirmed.

import type { AstroCookies } from 'astro';
import { getFirebaseAdminApp } from './firebase-admin';
import { idTokenForUser, refreshSessionForUser, type SessionIdentity } from './auth';
import { firebaseApiKey } from './runtime-config-server';

export const VERIFY_EMAIL_PATH = '/verify-email';

/** Where Firebase's confirmation page sends the person afterwards. */
export function verificationContinueUrl(portalOrigin: string, next: string | null): string {
  const url = new URL(VERIFY_EMAIL_PATH, portalOrigin);
  if (next) url.searchParams.set('next', next);
  return url.toString();
}

export type SendVerificationResult = 'sent' | 'skipped' | 'throttled';

/**
 * Ask Firebase to send its confirmation email to the identity's address.
 * Local dev and E2E identities have no Firebase account: nothing is sent.
 */
export async function sendVerificationEmail(identity: SessionIdentity, continueUrl: string): Promise<SendVerificationResult> {
  if (identity.authSource !== 'firebase') return 'skipped';
  const apiKey = firebaseApiKey();
  if (!apiKey) throw new Error('Firebase API key not configured');
  const idToken = await idTokenForUser(identity.userId, apiKey);
  // A continue URL on a domain missing from Firebase's authorized domains is
  // rejected. Confirmation must still work, so retry with Firebase's own page.
  for (const settings of [{ continueUrl }, {}]) {
    const response = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestType: 'VERIFY_EMAIL', idToken, ...settings }),
    });
    if (response.ok) return 'sent';
    const text = await response.text();
    if (/TOO_MANY_ATTEMPTS/.test(text)) return 'throttled';
    if (!/UNAUTHORIZED_DOMAIN|INVALID_CONTINUE_URI|UNAUTHORIZED_CONTINUE_URI/.test(text)) {
      throw new Error(`Firebase confirmation email failed (${response.status})`);
    }
  }
  throw new Error('Firebase confirmation email failed');
}

/**
 * Re-check the account in Firebase. When the address is now confirmed, mint a
 * fresh ID token and replace the session cookie so it carries
 * `email_verified: true`. Returns whether the account is confirmed.
 */
export async function confirmEmailVerification(cookies: AstroCookies, identity: SessionIdentity): Promise<boolean> {
  if (identity.emailVerified) return true;
  if (identity.authSource !== 'firebase') return false;
  const { getAuth } = await import('firebase-admin/auth');
  const user = await getAuth(await getFirebaseAdminApp()).getUser(identity.userId);
  if (user.disabled || !user.email || !user.emailVerified) return false;
  const apiKey = firebaseApiKey();
  if (!apiKey) throw new Error('Firebase API key not configured');
  await refreshSessionForUser(cookies, identity.userId, apiKey);
  return true;
}
