// Server-side session helpers.
//
// Strategy: the client signs in with Firebase Auth, then POSTs the ID token to
// /api/auth/session, which verifies it with firebase-admin and sets a signed
// session cookie. Page routes read the cookie and load the current user.
//
// In non-production environments with no Firebase Admin credentials configured,
// a `dev` cookie short-circuits to a default user so the portal is usable
// without setup. Production always fails closed when Firebase is absent.
//
// A "pending session" is a verified Firebase user who has not yet been
// assigned to an org. orgId is undefined in that case. The middleware
// redirects such users to /onboarding. Use isPendingSession() to check.
//
// Email confirmation gate: getSession() only returns sessions whose identity
// carries a confirmed email address (`email_verified: true` in the Firebase
// session cookie, which repeats the claims of the ID token it was minted from).
// Every page, API route and guard that trusts a signed-in person goes through
// getSession(), so an unconfirmed account is signed out everywhere except the
// few places that call getSessionIdentity() on purpose: the "Check your email"
// page and its resend/confirm endpoints, /login and the middleware redirect.
// Cookies issued before this gate existed are re-checked on every request; a
// missing claim counts as unconfirmed.
//
// Sign-out: /api/auth/logout revokes the cookie's Firebase sign-in in a
// server-side denylist (lib/session-revocation.ts) before deleting the cookie,
// so a copied cookie stops working too. Firebase refresh tokens are not
// revoked: that would end the person's other devices and OAuth/MCP keys.

import type { AstroCookies } from 'astro';
import { resolveOrganizationSession, clearOrganization } from './organization-session';
import { readE2ESessionCookie } from './e2e-auth';
import { getFirebaseAdminApp, isFirebaseAdminConfigured } from './firebase-admin';
import { MAX_SESSION_COOKIE_LIFETIME_MS, isSignInRevoked, recordSignInLineage, revokeSignIn, signInKey, signInRootKey } from './session-revocation';

export interface Session {
  userId: string;
  email: string;
  orgId: string | undefined;
  displayName?: string;
  /** When the session cookie expires (ms epoch). Drives the middleware's
   *  rolling refresh — present only for real Firebase sessions. */
  expiresAtMs?: number;
  /** True only when the identity provider reported a confirmed email
   *  address. getSession() never returns a session where this is false. */
  emailVerified?: boolean;
  /** Firebase `sign_in_provider` (`password`, `github.com`, `custom`, ...). */
  signInProvider?: string;
  /** Where the identity came from. E2E and dev identities never reach Firebase. */
  authSource?: 'firebase' | 'dev' | 'e2e';
}

/** A signed-in identity whose email address may still be unconfirmed. */
export type SessionIdentity = Session & { emailVerified: boolean };

/** Returns true when the user is authenticated but has not yet joined an org. */
export function isPendingSession(session: Session): boolean {
  return !session.orgId;
}

/**
 * The single rule for a confirmed account, shared by session exchange and
 * every session read. Only an explicit `email_verified: true` claim on an
 * identity with an email address counts. Providers that do not confirm
 * addresses for Firebase (GitHub reports `false`) and cookies without the
 * claim stay unconfirmed until the person opens Firebase's confirmation link.
 */
export function hasConfirmedEmail(claims: { email?: unknown; email_verified?: unknown } | null | undefined): boolean {
  return !!claims && typeof claims.email === 'string' && claims.email.length > 0 && claims.email_verified === true;
}

const SESSION_COOKIE = 'typeroll_session';
const DEV_USER: Session = {
  userId: 'dev-user',
  email: 'dev@typeroll.local',
  orgId: 'default',
  displayName: 'Dev User',
  authSource: 'dev',
};

export function isFirebaseConfigured(): boolean {
  return isFirebaseAdminConfigured();
}

export function isDevAuthEnabled(): boolean {
  return process.env.NODE_ENV !== 'production' && !isFirebaseConfigured();
}

/**
 * The signed-in person with a confirmed email address, or null. This is the
 * authentication decision for every page, API route and guard: an account
 * whose email is unconfirmed is treated exactly like a signed-out visitor.
 */
export async function getSession(cookies: AstroCookies): Promise<Session | null> {
  const identity = await getSessionIdentity(cookies);
  return identity?.emailVerified ? identity : null;
}

/**
 * The signed-in identity even when its email is unconfirmed. Only the email
 * confirmation flow, /login and the middleware redirect may use this. An
 * unconfirmed identity never has an Organization and must not be authorized.
 */
export async function getSessionIdentity(cookies: AstroCookies): Promise<SessionIdentity | null> {
  const raw = cookies.get(SESSION_COOKIE)?.value;

  if (!raw) {
    // No Firebase in non-production → use the local development session.
    if (isDevAuthEnabled()) return confirmedIdentity(cookies, DEV_USER);
    return null;
  }

  if (raw === 'dev' && isDevAuthEnabled()) return confirmedIdentity(cookies, DEV_USER);

  const e2eSession = readE2ESessionCookie(raw);
  if (e2eSession) {
    const { emailVerified, ...session } = e2eSession;
    if (!emailVerified) return { ...session, orgId: undefined, emailVerified: false, authSource: 'e2e' };
    return confirmedIdentity(cookies, { ...session, authSource: 'e2e' });
  }

  try {
    const decoded = await verifiedSessionClaims(cookies, raw);
    if (!decoded) return null;
    return await identityFromClaims(cookies, decoded, typeof decoded.exp === 'number' ? decoded.exp * 1000 : undefined);
  } catch {
    return null;
  }
}

type VerifiedClaims = IdentityClaims & { exp?: number };

/**
 * Verified claims of a Firebase session cookie, memoized per request.
 *
 * Middleware, guards and the page or route all read the session; Firebase
 * verification (with its revocation check) and the sign-out denylist read
 * run once per request. Astro creates one cookies object per request and
 * shares it between middleware and the page, so the memo lives exactly as
 * long as the request and is never shared across requests. It is keyed by
 * the cookie value, so a cookie set or deleted during the request is
 * verified again; revokeCurrentSession() clears it.
 */
const verifiedSessions = new WeakMap<object, Map<string, Promise<VerifiedClaims | null>>>();

function verifiedSessionClaims(cookies: AstroCookies, raw: string): Promise<VerifiedClaims | null> {
  let byValue = verifiedSessions.get(cookies);
  if (!byValue) { byValue = new Map(); verifiedSessions.set(cookies, byValue); }
  let verified = byValue.get(raw);
  if (!verified) {
    verified = (async () => {
      const { getAuth } = await import('firebase-admin/auth');
      const app = await getFirebaseAdminApp();
      // A failed revocation lookup must never restore access for disabled,
      // deleted or revoked users: every error rejects the session.
      const decoded = await getAuth(app).verifySessionCookie(raw, true);
      // Signed out on this browser or another copy of the same sign-in
      // (lib/session-revocation.ts). A failed lookup rejects the session too.
      const key = signInKey(decoded);
      if (key && await isSignInRevoked(key)) return null;
      return decoded as VerifiedClaims;
    })().catch(() => null);
    byValue.set(raw, verified);
  }
  return verified;
}

async function confirmedIdentity(cookies: AstroCookies, session: Session): Promise<SessionIdentity> {
  return { ...await resolveOrganizationSession(cookies, session), emailVerified: true };
}

interface IdentityClaims {
  uid: string;
  email?: string;
  email_verified?: boolean;
  name?: unknown;
  org_id?: unknown;
  firebase?: { sign_in_provider?: string };
}

async function identityFromClaims(cookies: AstroCookies, decoded: IdentityClaims, expiresAtMs?: number): Promise<SessionIdentity> {
  const session: Session = {
    userId: decoded.uid,
    email: decoded.email ?? '',
    orgId: decoded.org_id as string | undefined,
    displayName: decoded.name as string | undefined,
    ...(expiresAtMs ? { expiresAtMs } : {}),
    ...(decoded.firebase?.sign_in_provider ? { signInProvider: decoded.firebase.sign_in_provider } : {}),
    authSource: 'firebase',
  };
  // Unconfirmed accounts keep their memberships, but none is resolved,
  // selected or remembered until the email address is confirmed.
  if (!hasConfirmedEmail(decoded)) return { ...session, orgId: undefined, emailVerified: false };
  // Resolve the browser selection or membership index before treating a
  // missing legacy claim as pending. Identity verification remains mandatory.
  return confirmedIdentity(cookies, session);
}

// Firebase caps a single session cookie at 14 days. "Stay signed in until I
// log out" is therefore implemented as a rolling refresh: once a cookie has
// burned more than a day of its lifetime, the next page view re-mints it for
// a fresh 14 days. Active users never hit the cliff; an abandoned session
// still dies within 14 days of the last visit.
export const SESSION_LIFETIME_MS = MAX_SESSION_COOKIE_LIFETIME_MS;
const SESSION_REFRESH_AFTER_MS = 24 * 60 * 60 * 1000; // refresh at most ~daily

export function sessionNeedsRefresh(session: Session, now = Date.now()): boolean {
  if (!session.expiresAtMs) return false;
  return session.expiresAtMs - now < SESSION_LIFETIME_MS - SESSION_REFRESH_AFTER_MS;
}

export async function setSessionFromIdToken(
  cookies: AstroCookies,
  idToken: string
): Promise<SessionIdentity> {
  const { getAuth } = await import('firebase-admin/auth');
  const app = await getFirebaseAdminApp();

  const expiresIn = SESSION_LIFETIME_MS;
  const decoded = await getAuth(app).verifyIdToken(idToken, true);
  const age = Date.now() / 1000 - decoded.auth_time;
  if (!Number.isFinite(age) || age < -60 || age > 300) throw new Error('Recent sign-in required');
  // A sign-in that was already signed out cannot be exchanged again.
  const key = signInKey(decoded);
  if (key && await isSignInRevoked(key)) throw new Error('Session was signed out');
  const sessionCookie = await getAuth(app).createSessionCookie(idToken, { expiresIn });

  // An unconfirmed account still receives a cookie, but getSession() refuses
  // it: it only opens the "Check your email" page.
  setSessionCookie(cookies, sessionCookie, expiresIn);

  // The selected organization is resolved independently of identity claims.
  // Only accounts without a valid membership continue to onboarding.
  return identityFromClaims(cookies, decoded);
}

function setSessionCookie(cookies: AstroCookies, value: string, expiresIn: number): void {
  cookies.set(SESSION_COOKIE, value, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: expiresIn / 1000,
  });
}

export function clearSession(cookies: AstroCookies): void {
  cookies.delete(SESSION_COOKIE, { path: '/' });
  clearOrganization(cookies);
}

/**
 * Sign-out on the server: revoke the Firebase sign-in behind the current
 * cookie so copies of it (and cookies refreshed from them) stop working. The
 * person's other sign-ins and their OAuth/MCP connections are unaffected,
 * because Firebase refresh tokens are not revoked. Dev and E2E sessions have
 * no Firebase sign-in; clearing their cookie is enough. Returns whether a
 * sign-in was revoked. Throws when the denylist cannot be written.
 */
export async function revokeCurrentSession(cookies: AstroCookies): Promise<boolean> {
  const raw = cookies.get(SESSION_COOKIE)?.value;
  if (!raw || raw === 'dev' || readE2ESessionCookie(raw) || !isFirebaseConfigured()) return false;
  const { getAuth } = await import('firebase-admin/auth');
  let decoded;
  try {
    // Signature and expiry only: a disabled account can still sign out.
    decoded = await getAuth(await getFirebaseAdminApp()).verifySessionCookie(raw, false);
  } catch {
    return false; // Expired or forged: nothing that could still sign in.
  }
  const key = signInKey(decoded);
  if (!key) return false;
  // Later reads in this request must see the revocation.
  verifiedSessions.delete(cookies);
  await revokeSignIn(key);
  verifiedSessions.delete(cookies);
  return true;
}

/**
 * Refreshes the session cookie for a user server-side, picking up any custom
 * claim changes (e.g. a newly-set org_id) or a newly confirmed email address
 * without requiring the client to have an active Firebase SDK auth state.
 *
 * The request must carry this user's current, valid and not signed-out
 * session cookie; the new cookie is recorded as a continuation of its sign-in.
 *
 * Throws if the Firebase API key is missing, the current cookie is missing,
 * invalid or signed out, or the REST exchange fails.
 */
export async function refreshSessionForUser(
  cookies: AstroCookies,
  userId: string,
  firebaseApiKey: string
): Promise<void> {
  const { getAuth } = await import('firebase-admin/auth');
  const app = await getFirebaseAdminApp();

  // Only the browser's own, still valid sign-in may be re-minted. A signed-out
  // cookie (or a copy of one) must never turn into a fresh one.
  const raw = cookies.get(SESSION_COOKIE)?.value;
  if (!raw) throw new Error('No session cookie to refresh');
  const current = await getAuth(app).verifySessionCookie(raw, true);
  if (current.uid !== userId) throw new Error('Session cookie belongs to another user');
  const currentKey = signInKey(current);
  const rootKey = currentKey ? await signInRootKey(currentKey) : null;
  if (currentKey && rootKey && (await isSignInRevoked(currentKey) || await isSignInRevoked(rootKey))) {
    throw new Error('Session was signed out');
  }

  const idToken = await idTokenForUser(userId, firebaseApiKey);

  // Every caller refreshes a confirmed account (rolling refresh, new
  // Organization claims, a just-confirmed email). Never replace a working
  // cookie with one the email gate would reject.
  const refreshed = await getAuth(app).verifyIdToken(idToken);
  if (!hasConfirmedEmail(refreshed)) {
    throw new Error('Refreshed identity has no confirmed email');
  }

  // Create a long-lived session cookie from the fresh ID token and set it on
  // the response. This replaces the old cookie and its claims.
  const expiresIn = SESSION_LIFETIME_MS;
  const sessionCookie = await getAuth(app).createSessionCookie(idToken, { expiresIn });
  // The custom-token exchange is a new Firebase sign-in with its own
  // auth_time: link it to the sign-in it continues so sign-out revokes both.
  const refreshedKey = signInKey(refreshed);
  if (rootKey && refreshedKey) await recordSignInLineage(refreshedKey, rootKey);
  setSessionCookie(cookies, sessionCookie, expiresIn);
}

/**
 * A fresh Firebase ID token for a user, minted server-side. It repeats the
 * user's current record: custom claims (org_id), email and email_verified.
 *
 * Flow: Firebase Admin creates a short-lived custom token → the Identity
 * Toolkit REST API exchanges it for an ID token.
 */
export async function idTokenForUser(userId: string, firebaseApiKey: string): Promise<string> {
  const { getAuth } = await import('firebase-admin/auth');
  const app = await getFirebaseAdminApp();

  // A signed custom token for this user: a short-lived JWT signed by the
  // service account. It carries no claims itself; Firebase Auth looks up the
  // user's current record when it issues the real ID token.
  const customToken = await getAuth(app).createCustomToken(userId);

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
  return idToken;
}
