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

import type { AstroCookies } from 'astro';
import { resolveOrganizationSession, clearOrganization } from './organization-session';
import { readE2ESessionCookie } from './e2e-auth';
import { getFirebaseAdminApp, isFirebaseAdminConfigured } from './firebase-admin';

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
    const { getAuth } = await import('firebase-admin/auth');
    const app = await getFirebaseAdminApp();

    // A failed revocation lookup must never restore access for disabled,
    // deleted or revoked users. The outer catch rejects the session.
    const decoded = await getAuth(app).verifySessionCookie(raw, true);
    return await identityFromClaims(cookies, decoded, typeof decoded.exp === 'number' ? decoded.exp * 1000 : undefined);
  } catch {
    return null;
  }
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
export const SESSION_LIFETIME_MS = 14 * 24 * 60 * 60 * 1000;
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
 * Refreshes the session cookie for a user server-side, picking up any custom
 * claim changes (e.g. a newly-set org_id) or a newly confirmed email address
 * without requiring the client to have an active Firebase SDK auth state.
 *
 * Throws if the Firebase API key is missing or the REST exchange fails.
 */
export async function refreshSessionForUser(
  cookies: AstroCookies,
  userId: string,
  firebaseApiKey: string
): Promise<void> {
  const { getAuth } = await import('firebase-admin/auth');
  const app = await getFirebaseAdminApp();
  const idToken = await idTokenForUser(userId, firebaseApiKey);

  // Every caller refreshes a confirmed account (rolling refresh, new
  // Organization claims, a just-confirmed email). Never replace a working
  // cookie with one the email gate would reject.
  if (!hasConfirmedEmail(await getAuth(app).verifyIdToken(idToken))) {
    throw new Error('Refreshed identity has no confirmed email');
  }

  // Create a long-lived session cookie from the fresh ID token and set it on
  // the response. This replaces the old cookie and its claims.
  const expiresIn = SESSION_LIFETIME_MS;
  const sessionCookie = await getAuth(app).createSessionCookie(idToken, { expiresIn });
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
