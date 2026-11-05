// Email confirmation for accounts without a confirmed address (new password
// sign-ups, GitHub accounts whose address GitHub has not verified).
//
// Better Auth sends the link (lib/identity/portal-auth.ts → account mail) and
// marks the address confirmed when it is opened. Sessions are read from the
// store on every request, so the next request already sees the confirmation;
// no cookie has to be re-issued.

import type { SessionIdentity } from './auth';
import { getPortalAuth } from './identity/portal-auth';

export const VERIFY_EMAIL_PATH = '/verify-email';

/** Where the confirmation link sends the person afterwards (same origin, relative). */
export function verificationCallbackPath(next: string | null): string {
  return next ? `${VERIFY_EMAIL_PATH}?next=${encodeURIComponent(next)}` : VERIFY_EMAIL_PATH;
}

export type SendVerificationResult = 'sent' | 'skipped';

/**
 * Send a confirmation link to the identity's own address. Development and E2E
 * identities have no account: nothing is sent.
 */
export async function sendVerificationEmail(identity: SessionIdentity, next: string | null): Promise<SendVerificationResult> {
  if (identity.authSource !== 'account') return 'skipped';
  const auth = getPortalAuth();
  if (!auth) throw new Error('Sign-in is not configured');
  await auth.api.sendVerificationEmail({ body: { email: identity.email, callbackURL: verificationCallbackPath(next) } });
  return 'sent';
}
