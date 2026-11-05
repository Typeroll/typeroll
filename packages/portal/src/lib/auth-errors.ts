/** Do not reveal provider internals or whether a sign-in address exists. */
export function authErrorMessage(error: unknown): string {
  const { code, status } = (error ?? {}) as { code?: string; status?: number };
  if (status === 429 || code === 'TOO_MANY_REQUESTS') return 'Too many attempts. Please wait a few minutes and try again.';
  if (code === 'NETWORK') return 'Could not connect. Check your connection and try again.';
  if (code === 'PASSWORD_TOO_SHORT' || code === 'PASSWORD_TOO_LONG') return 'Choose a password with 12 to 128 characters.';
  if (code === 'USER_ALREADY_EXISTS' || code === 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL') return 'Could not create an account with these details. Try signing in or resetting your password.';
  if (code === 'INVALID_TOKEN' || code === 'invalid_token') return 'This link has expired or was already used. Request a new one.';
  if (status === 503) return 'Sign-in is currently unavailable. Please try again later.';
  return 'Could not sign in with these details. Check your email and password, or reset your password.';
}

/** Copy for `?error=` after a GitHub sign-in returns to /login. */
export function oauthErrorMessage(code: string | null): string | null {
  if (!code) return null;
  if (code === 'unable_to_link_account' || code === 'account_not_linked') {
    return 'An account already uses this email address. Sign in with your email and password, confirm your email address, then try GitHub again.';
  }
  if (code === 'account_already_linked_to_different_user') return 'This GitHub account is already linked to another Typeroll account.';
  if (code === 'email_not_found') return 'GitHub did not share an email address. Add a verified email address on GitHub and try again.';
  if (code === 'access_denied') return 'GitHub sign-in was cancelled.';
  return 'Could not sign in with GitHub. Please try again or use your email and password.';
}
