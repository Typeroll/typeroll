// Server-side session helpers.
//
// Strategy: the client signs in with Firebase Auth, then POSTs the ID token to
// /api/auth/session, which verifies it with firebase-admin and sets a signed
// session cookie. Page routes read the cookie and load the current user.
//
// In non-production environments with no Firebase service account configured,
// a `dev` cookie short-circuits to a default user so the portal is usable
// without setup. Production always fails closed when Firebase is absent.
//
// A "pending session" is a verified Firebase user who has not yet been
// assigned to an org. orgId is undefined in that case. The middleware
// redirects such users to /onboarding. Use isPendingSession() to check.

import type { AstroCookies } from 'astro';

export interface Session {
  userId: string;
  email: string;
  orgId: string | undefined;
  displayName?: string;
  /** When the session cookie expires (ms epoch). Drives the middleware's
   *  rolling refresh — present only for real Firebase sessions. */
  expiresAtMs?: number;
}

/** Returns true when the user is authenticated but has not yet joined an org. */
export function isPendingSession(session: Session): boolean {
  return !session.orgId;
}

const SESSION_COOKIE = 'typeroll_session';
const DEV_USER: Session = {
  userId: 'dev-user',
  email: 'dev@typeroll.local',
  orgId: 'default',
  displayName: 'Dev User',
};

export function isFirebaseConfigured(): boolean {
  const sa = process.env.FIREBASE_SERVICE_ACCOUNT;
  return Boolean(sa && sa.trim().startsWith('{'));
}

export function isDevAuthEnabled(): boolean {
  return process.env.NODE_ENV !== 'production' && !isFirebaseConfigured();
}

export async function getSession(cookies: AstroCookies): Promise<Session | null> {
  const raw = cookies.get(SESSION_COOKIE)?.value;

  if (!raw) {
    // No Firebase in non-production → use the local development session.
    if (isDevAuthEnabled()) return DEV_USER;
    return null;
  }

  if (raw === 'dev' && isDevAuthEnabled()) return DEV_USER;

  try {
    const { getAuth } = await import('firebase-admin/auth');
    const { initializeApp, cert, getApps } = await import('firebase-admin/app');
    const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT!);
    if (!getApps().length) initializeApp({ credential: cert(sa) });

    // checkRevoked=true needs a network round-trip to Firebase. A transient
    // failure there must NOT log the user out — fall back to the local
    // verification (signature + expiry are still cryptographically checked;
    // only the revocation lookup is skipped). Definitive auth errors
    // (expired/revoked/invalid) never reach the fallback: the local check
    // re-raises them, and `auth/session-cookie-revoked` is excluded
    // explicitly. Revoked users are also caught at the next rolling refresh,
    // which re-validates against Firebase.
    let decoded;
    try {
      decoded = await getAuth().verifySessionCookie(raw, true);
    } catch (err) {
      const code = (err as { code?: string }).code ?? '';
      if (code === 'auth/session-cookie-revoked') return null;
      decoded = await getAuth().verifySessionCookie(raw, false);
    }
    const orgId = decoded.org_id as string | undefined;
    // Note: a missing org_id is a "pending session" — the user is authenticated
    // but hasn't joined an org yet. The middleware redirects such users to
    // /onboarding. We do NOT reject here so the onboarding API routes can
    // still read the session.
    return {
      userId: decoded.uid,
      email: decoded.email ?? '',
      orgId,
      displayName: decoded.name as string | undefined,
      expiresAtMs: typeof decoded.exp === 'number' ? decoded.exp * 1000 : undefined,
    };
  } catch {
    return null;
  }
}

// Firebase caps a single session cookie at 14 days. "Stay signed in until I
// log out" is therefore implemented as a rolling refresh: once a cookie has
// burned more than a day of its lifetime, the next page view re-mints it for
// a fresh 14 days. Active users never hit the cliff; an abandoned session
// still dies within 14 days of the last visit.
export const SESSION_LIFETIME_MS = 14 * 24 * 60 * 60 * 1000;
const SESSION_REFRESH_AFTER_MS = 24 * 60 * 60 * 1000; // refresh at most ~daily

export function sessionNeedsRefresh(session: Session, now = Date.now()): boolean {
  if (!session.expiresAtMs) return false;
  return session.expiresAtMs - now < SESSION_LIFETIME_MS - SESSION_REFRESH_AFTER_MS;
}

export async function setSessionFromIdToken(
  cookies: AstroCookies,
  idToken: string
): Promise<Session> {
  const { getAuth } = await import('firebase-admin/auth');
  const { initializeApp, cert, getApps } = await import('firebase-admin/app');
  const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT!);
  if (!getApps().length) initializeApp({ credential: cert(sa) });

  const expiresIn = SESSION_LIFETIME_MS;
  const sessionCookie = await getAuth().createSessionCookie(idToken, { expiresIn });
  const decoded = await getAuth().verifyIdToken(idToken);

  cookies.set(SESSION_COOKIE, sessionCookie, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: expiresIn / 1000,
  });

  const orgId = decoded.org_id as string | undefined;
  // A missing org_id yields a "pending session". The user is redirected to
  // /onboarding where they can create or join an org. After that, the client
  // calls getIdToken(true) to force-refresh the claim and re-exchanges the
  // session cookie.
  return {
    userId: decoded.uid,
    email: decoded.email ?? '',
    orgId,
    displayName: decoded.name as string | undefined,
  };
}

export function clearSession(cookies: AstroCookies): void {
  cookies.delete(SESSION_COOKIE, { path: '/' });
}

/**
 * Refreshes the session cookie for a user server-side, picking up any custom
 * claim changes (e.g. a newly-set org_id) without requiring the client to have
 * an active Firebase SDK auth state.
 *
 * Flow: Firebase Admin creates a short-lived custom token → exchanges it for
 * an ID token via the Firebase REST API (which embeds the latest custom claims)
 * → creates a new long-lived session cookie.
 *
 * Throws if the Firebase API key is missing or the REST exchange fails.
 */
export async function refreshSessionForUser(
  cookies: AstroCookies,
  userId: string,
  firebaseApiKey: string
): Promise<void> {
  const { getAuth } = await import('firebase-admin/auth');
  const { initializeApp, cert, getApps } = await import('firebase-admin/app');
  const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT!);
  if (!getApps().length) initializeApp({ credential: cert(sa) });

  // Step 1: create a signed custom token for this user. This is a short-lived
  // JWT signed by the service account; it carries no custom claims itself but
  // Firebase Auth uses the UID to look up the user's current claims when it
  // issues the real ID token.
  const customToken = await getAuth().createCustomToken(userId);

  // Step 2: exchange the custom token for a full ID token via the Firebase
  // Identity Toolkit REST API. The returned ID token will include the latest
  // org_id custom claim that was just set with setCustomUserClaims.
  const tokenRes = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${firebaseApiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: customToken, returnSecureToken: true }),
    }
  );

  if (!tokenRes.ok) {
    const body = await tokenRes.text();
    throw new Error(`Firebase token exchange failed (${tokenRes.status}): ${body}`);
  }

  const { idToken } = (await tokenRes.json()) as { idToken: string };

  // Step 3: create a long-lived session cookie from the fresh ID token and set
  // it on the response. This replaces the old cookie that lacked org_id.
  const expiresIn = SESSION_LIFETIME_MS;
  const sessionCookie = await getAuth().createSessionCookie(idToken, { expiresIn });

  cookies.set(SESSION_COOKIE, sessionCookie, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: expiresIn / 1000,
  });
}
