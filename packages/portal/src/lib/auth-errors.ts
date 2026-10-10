/** Do not reveal provider internals or whether a sign-in address exists. */
export function authErrorMessage(error: unknown): string {
  const code = (error as { code?: string })?.code;
  if (code === 'auth/too-many-requests') return 'Too many attempts. Please wait a few minutes and try again.';
  if (code === 'auth/network-request-failed') return 'Could not connect. Check your connection and try again.';
  if (code === 'auth/weak-password' || code === 'auth/password-does-not-meet-requirements') return 'Choose a stronger password with at least 12 characters.';
  if (code === 'auth/email-already-in-use') return 'Could not create an account with these details. Try signing in or resetting your password.';
  if (code === 'auth/session-failed') return 'Could not finish signing in. Please try again.';
  return 'Could not sign in with these details. Check your email and password, or reset your password.';
}
