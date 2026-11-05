// Server-side session helpers.
//
// Sign-in, sign-up, email confirmation and password reset are Better Auth
// endpoints under /api/auth (lib/identity/portal-auth.ts). A session is a row
// in the store behind an opaque HttpOnly cookie; there is no cookie cache, so
// sign-out, a password reset or disabling a person ends it on the next request.
//
// Without AUTH_SECRET outside production, a built-in development user is used
// so the portal works without setup. Production always fails closed.
//
// A "pending session" is a confirmed person who has not yet joined an
// Organization: orgId is undefined and the middleware sends them to onboarding.
//
// Email confirmation gate: getSession() only returns sessions whose person has
// a confirmed email address. Every page, API route and guard that trusts a
// signed-in person goes through getSession(), so an unconfirmed account is
// signed out everywhere except the few places that call getSessionIdentity()
// on purpose: the "Check your email" page and its endpoints, /login and the
// middleware redirect.

import type { AstroCookies } from 'astro';
import { resolveOrganizationSession, clearOrganization } from './organization-session';
import { readE2ESessionCookie } from './e2e-auth';
import { getPortalAuth, isIdentityConfigured } from './identity/portal-auth';
import { PORTAL_COOKIE_PREFIX } from './identity/constants';
import { isLocalE2EMode } from './local-e2e';

export interface Session {
  userId: string;
  email: string;
  orgId: string | undefined;
  displayName?: string;
  /** When the session row expires (ms epoch). */
  expiresAtMs?: number;
  /** When this sign-in happened (ms epoch). */
  signedInAtMs?: number;
  /** True only for a confirmed email address. getSession() never returns false. */
  emailVerified?: boolean;
  /** Where the identity came from. Development and E2E identities have no account. */
  authSource?: 'account' | 'dev' | 'e2e';
}

/** A signed-in identity whose email address may still be unconfirmed. */
export type SessionIdentity = Session & { emailVerified: boolean };

/** Returns true when the user is authenticated but has not yet joined an org. */
export function isPendingSession(session: Session): boolean {
  return !session.orgId;
}

const DEV_COOKIE = 'typeroll_session';
// Computed on use: the bundled Worker evaluates chunks in an order where an
// imported constant can still be undefined while this module initializes.
const sessionCookieNames = () => [`__Secure-${PORTAL_COOKIE_PREFIX}.session_token`, `${PORTAL_COOKIE_PREFIX}.session_token`];
const rememberCookieNames = () => [`__Secure-${PORTAL_COOKIE_PREFIX}.dont_remember`, `${PORTAL_COOKIE_PREFIX}.dont_remember`];
const DEV_USER: Session = {
  userId: 'dev-user',
  email: 'dev@typeroll.local',
  orgId: 'default',
  displayName: 'Dev User',
  authSource: 'dev',
};

/** Whether this deployment has accounts (Better Auth) at all. */
export function isAccountSignInConfigured(): boolean {
  return isIdentityConfigured();
}

/**
 * The development user: outside production builds, and in the production
 * Worker build only in local E2E mode (lib/local-e2e.ts), whose suite still
 * drives most specs as that user.
 */
export function isDevAuthEnabled(): boolean {
  return (process.env.NODE_ENV !== 'production' || isLocalE2EMode()) && !isIdentityConfigured();
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
  const dev = cookies.get(DEV_COOKIE)?.value;
  if (dev) {
    if (dev === 'dev' && isDevAuthEnabled()) return confirmedIdentity(cookies, DEV_USER);
    const e2eSession = readE2ESessionCookie(dev);
    if (e2eSession) {
      const { emailVerified, ...session } = e2eSession;
      if (!emailVerified) return { ...session, orgId: undefined, emailVerified: false, authSource: 'e2e' };
      return confirmedIdentity(cookies, { ...session, authSource: 'e2e' });
    }
  }

  const cookieHeader = sessionCookieHeader(cookies);
  if (!cookieHeader) return isDevAuthEnabled() ? confirmedIdentity(cookies, DEV_USER) : null;
  const account = await accountSession(cookies, cookieHeader);
  if (!account) return null;
  const session: Session = {
    userId: account.user.id,
    email: account.user.email,
    orgId: undefined,
    displayName: account.user.name || undefined,
    expiresAtMs: new Date(account.session.expiresAt).getTime(),
    signedInAtMs: new Date(account.session.createdAt).getTime(),
    authSource: 'account',
  };
  // Unconfirmed accounts keep their memberships, but none is resolved,
  // selected or remembered until the email address is confirmed.
  if (!account.user.emailVerified) return { ...session, emailVerified: false };
  return confirmedIdentity(cookies, session);
}

interface AccountSession {
  user: { id: string; email: string; name?: string | null; emailVerified: boolean; disabled?: boolean | null };
  session: { id: string; expiresAt: string | Date; createdAt: string | Date };
}

/**
 * The Better Auth session behind the cookie, memoized per request. Astro
 * shares one cookies object between middleware and page for a request, so
 * the memo never crosses requests; it is keyed by the cookie value.
 * A refreshed expiry (Better Auth extends a session at most daily) is written
 * back to the browser through the same cookies object.
 */
const sessionsByRequest = new WeakMap<object, Map<string, Promise<AccountSession | null>>>();

function accountSession(cookies: AstroCookies, cookieHeader: string): Promise<AccountSession | null> {
  let byValue = sessionsByRequest.get(cookies);
  if (!byValue) { byValue = new Map(); sessionsByRequest.set(cookies, byValue); }
  let found = byValue.get(cookieHeader);
  if (!found) {
    found = (async () => {
      const auth = getPortalAuth();
      if (!auth) return null;
      const result = await auth.api.getSession({ headers: new Headers({ cookie: cookieHeader }), query: { disableCookieCache: true }, returnHeaders: true });
      applySetCookies(cookies, result.headers);
      const value = result.response as AccountSession | null;
      // A failed lookup or a disabled person never restores access.
      if (!value?.user || value.user.disabled) return null;
      return value;
    })().catch(error => {
      // Fail closed; log the cause without cookie or identity details.
      console.error('[auth] session lookup failed:', error instanceof Error ? error.message : 'unknown error');
      return null;
    });
    byValue.set(cookieHeader, found);
  }
  return found;
}

function sessionCookieHeader(cookies: AstroCookies): string | null {
  const parts: string[] = [];
  for (const name of [...sessionCookieNames(), ...rememberCookieNames()]) {
    const value = cookies.get(name, { decode: v => v })?.value;
    if (value) parts.push(`${name}=${value}`);
  }
  return parts.some(part => sessionCookieNames().some(name => part.startsWith(`${name}=`))) ? parts.join('; ') : null;
}

async function confirmedIdentity(cookies: AstroCookies, session: Session): Promise<SessionIdentity> {
  return { ...await resolveOrganizationSession(cookies, session), emailVerified: true };
}

/** Copy Set-Cookie headers from a Better Auth response onto Astro's cookies. */
export function applySetCookies(cookies: AstroCookies, headers: Headers | null | undefined): void {
  for (const line of headers?.getSetCookie?.() ?? []) {
    const [pair, ...attributes] = line.split(';');
    const separator = pair!.indexOf('=');
    if (separator < 1) continue;
    const name = pair!.slice(0, separator).trim();
    const value = pair!.slice(separator + 1).trim();
    const options: Parameters<AstroCookies['set']>[2] = { encode: v => v, path: '/' };
    for (const attribute of attributes) {
      const [rawKey, ...rest] = attribute.split('=');
      const key = rawKey!.trim().toLowerCase();
      const attributeValue = rest.join('=').trim();
      if (key === 'max-age') options.maxAge = Number(attributeValue);
      else if (key === 'expires') options.expires = new Date(attributeValue);
      else if (key === 'path') options.path = attributeValue;
      else if (key === 'httponly') options.httpOnly = true;
      else if (key === 'secure') options.secure = true;
      else if (key === 'samesite') options.sameSite = attributeValue.toLowerCase() as 'lax' | 'strict' | 'none';
    }
    if (options.maxAge === 0 || value === '') cookies.delete(name, { path: options.path });
    else cookies.set(name, value, options);
  }
}

export function clearSession(cookies: AstroCookies): void {
  for (const name of [DEV_COOKIE, ...sessionCookieNames(), ...rememberCookieNames()]) cookies.delete(name, { path: '/' });
  clearOrganization(cookies);
}

/**
 * Sign-out on the server: delete the session row behind the cookie so every
 * copy of it stops working. The person's other sessions and their OAuth/MCP
 * connections are unaffected. Development and E2E identities have no row.
 * Returns whether a session was ended. Throws when the store cannot be written.
 */
export async function revokeCurrentSession(cookies: AstroCookies): Promise<boolean> {
  const cookieHeader = sessionCookieHeader(cookies);
  const auth = getPortalAuth();
  if (!cookieHeader || !auth) return false;
  const current = await accountSession(cookies, cookieHeader);
  sessionsByRequest.delete(cookies);
  if (!current) return false;
  await auth.api.signOut({ headers: new Headers({ cookie: cookieHeader }) });
  return true;
}
