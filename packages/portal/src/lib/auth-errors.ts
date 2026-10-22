/** Do not reveal provider internals or whether a sign-in address exists. */
export function authErrorMessage(error: unknown): string {
  const code = (error as { code?: string })?.code;
  if (code === 'auth/too-many-requests') return 'Too many attempts. Please wait a few minutes and try again.';
  if (code === 'auth/network-request-failed') return 'Could not connect. Check your connection and try again.';
  if (code === 'auth/weak-password' || code === 'auth/password-does-not-meet-requirements') return 'Choose a stronger password with at least 12 characters.';
  if (code === 'auth/email-already-in-use') return 'Could not create an account with these details. Try signing in or resetting your password.';
  if (code === 'auth/session-failed') return 'Could not finish signing in. Please try again.';
  if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request' || code === 'auth/user-cancelled') return 'GitHub sign-in was cancelled.';
  if (code === 'auth/credential-already-in-use') return 'This GitHub account is already linked to another Typeroll account.';
  if (code === 'auth/provider-already-linked') return 'A different GitHub account is already linked to this Typeroll account.';
  if (code === 'auth/operation-not-allowed' || code === 'auth/unauthorized-domain') return 'This sign-in method is not available here. Sign in with your email and password.';
  return 'Could not sign in with these details. Check your email and password, or reset your password.';
}
