// The portal's Better Auth instance: email + password, optional GitHub,
// email confirmation and password reset, database sessions without a cookie
// cache (sign-out takes effect at once), and a store-backed rate limit.
//
// Identity rows live in the document store under `auth_*` collections (the
// global object). User ids imported from Firebase keep their Firebase UID, so
// memberships and API-key ownership need no rewrite.
//
// Configuration:
//   AUTH_SECRET                  ≥ 32 characters; without it the portal has no
//                                sign-in (development falls back to dev auth)
//   PORTAL_PUBLIC_URL            the portal origin (base URL, trusted origin)
//   GITHUB_SIGNIN_CLIENT_ID/_SECRET  enables "Continue with GitHub"
//   ACCOUNT_EMAIL                provider for confirmation and reset mail
//   LEGACY_FIREBASE_SCRYPT       only while imported Firebase hashes remain

import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { createAuthMiddleware } from 'better-auth/api';
import { hashPassword, verifyPassword } from 'better-auth/crypto';
import { getStore, type ReadWriteStore } from '../datastore';
import { sendAccountMail, verificationMail, passwordResetMail } from './account-mail';
import { firebaseScryptParamsFromEnv, isFirebaseScryptHash, verifyFirebaseScrypt } from './firebase-scrypt';
import { storeAdapter, storeRateLimitStorage } from './store-adapter';

export const PORTAL_AUTH_BASE_PATH = '/api/auth';
export const PORTAL_AUTH_PREFIX = 'auth';
export const PORTAL_COOKIE_PREFIX = 'typeroll';
const SESSION_LIFETIME_S = 14 * 24 * 60 * 60;
const MIN_SECRET_LENGTH = 32;

export interface PortalAuthConfig {
  secret: string;
  baseURL: string;
  store?: () => ReadWriteStore;
  github?: { clientId: string; clientSecret: string };
  /** Secure cookies (`__Secure-` prefix); on for every non-local origin. */
  secureCookies?: boolean;
}

export function isIdentityConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return (env.AUTH_SECRET?.trim().length ?? 0) >= MIN_SECRET_LENGTH;
}

export function githubSignInConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return !!env.GITHUB_SIGNIN_CLIENT_ID?.trim() && !!env.GITHUB_SIGNIN_CLIENT_SECRET?.trim();
}

/** Default scrypt for new hashes; Firebase's modified scrypt only for imported ones. */
export async function verifyAccountPassword({ hash, password }: { hash: string; password: string }): Promise<boolean> {
  if (isFirebaseScryptHash(hash)) return verifyFirebaseScrypt(hash, password, firebaseScryptParamsFromEnv());
  return verifyPassword({ hash, password });
}

export function portalAuthOptions(config: PortalAuthConfig) {
  if (config.secret.length < MIN_SECRET_LENGTH) throw new Error(`AUTH_SECRET must be at least ${MIN_SECRET_LENGTH} characters`);
  const store = config.store ?? getStore;
  const origin = new URL(config.baseURL).origin;
  return {
    appName: 'Typeroll',
    secret: config.secret,
    baseURL: origin,
    basePath: PORTAL_AUTH_BASE_PATH,
    trustedOrigins: [origin],
    database: storeAdapter({ store, prefix: PORTAL_AUTH_PREFIX }),
    user: {
      additionalFields: {
        // Set by platform operators; a disabled person cannot sign in and
        // existing sessions stop working.
        disabled: { type: 'boolean', required: false, defaultValue: false, input: false },
        // Delegated credentials (MCP/OAuth connections) granted before this
        // moment stop working; set when an operator revokes them.
        credentialsValidAfter: { type: 'date', required: false, input: false, returned: false },
      },
    },
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      autoSignIn: true,
      requireEmailVerification: false,
      revokeSessionsOnPasswordReset: true,
      resetPasswordTokenExpiresIn: 60 * 60,
      password: { hash: hashPassword, verify: verifyAccountPassword },
      sendResetPassword: async ({ user, url }) => { await sendAccountMail(passwordResetMail(user.email, url)); },
    },
    emailVerification: {
      sendOnSignUp: true,
      sendOnSignIn: false,
      autoSignInAfterVerification: true,
      expiresIn: 60 * 60,
      sendVerificationEmail: async ({ user, url }) => { await sendAccountMail(verificationMail(user.email, url)); },
    },
    socialProviders: config.github ? {
      // Sign-in reads the person's email addresses and nothing else. GitHub
      // reports whether the address is verified; Better Auth links to an
      // existing account only when both sides have confirmed it.
      github: { clientId: config.github.clientId, clientSecret: config.github.clientSecret, scope: ['read:user', 'user:email'] },
    } : {},
    account: {
      accountLinking: { enabled: true, trustedProviders: [], allowDifferentEmails: false, requireLocalEmailVerified: true },
      encryptOAuthTokens: true,
      // GitHub access tokens are not used after sign-in.
      storeAccountCookie: false,
    },
    session: {
      expiresIn: SESSION_LIFETIME_S,
      updateAge: 24 * 60 * 60,
      freshAge: 5 * 60,
      cookieCache: { enabled: false },
    },
    rateLimit: {
      enabled: true,
      window: 60,
      max: 60,
      customStorage: storeRateLimitStorage(store, PORTAL_AUTH_PREFIX),
      customRules: {
        '/sign-in/email': { window: 60, max: 10 },
        '/sign-up/email': { window: 60 * 10, max: 10 },
        '/request-password-reset': { window: 60 * 10, max: 5 },
        '/send-verification-email': { window: 60 * 10, max: 5 },
        '/reset-password': { window: 60 * 10, max: 10 },
      },
    },
    advanced: {
      cookiePrefix: PORTAL_COOKIE_PREFIX,
      useSecureCookies: config.secureCookies ?? !isLocalOrigin(origin),
      ipAddress: { ipAddressHeaders: ['cf-connecting-ip'] },
      // Explicit: Better Auth relaxes both checks under NODE_ENV=test.
      disableOriginCheck: false,
      disableCSRFCheck: false,
      defaultCookieAttributes: { sameSite: 'lax', httpOnly: true, path: '/' },
    },
    databaseHooks: {
      session: {
        create: {
          before: async (session, ctx) => {
            const user = await ctx?.context.internalAdapter.findUserById(session.userId) as { disabled?: boolean } | null;
            if (!user || user.disabled) return false;
          },
        },
      },
    },
    hooks: {
      // An imported Firebase hash is replaced with the default algorithm on
      // the first successful sign-in; nobody has to reset a password.
      after: createAuthMiddleware(async ctx => {
        if (ctx.path !== '/sign-in/email') return;
        const userId = ctx.context.newSession?.user.id;
        const password = (ctx.body as { password?: unknown } | undefined)?.password;
        if (!userId || typeof password !== 'string') return;
        const accounts = await ctx.context.internalAdapter.findAccounts(userId);
        const credential = accounts.find(account => account.providerId === 'credential');
        if (!credential?.password || !isFirebaseScryptHash(credential.password)) return;
        await ctx.context.internalAdapter.updatePassword(userId, await ctx.context.password.hash(password));
      }),
    },
    telemetry: { enabled: false },
  } satisfies BetterAuthOptions;
}

export function createPortalAuth(config: PortalAuthConfig) {
  return betterAuth(portalAuthOptions(config));
}

export type PortalAuth = ReturnType<typeof createPortalAuth>;

let cached: { key: string; auth: PortalAuth } | null = null;

/** The configured instance, or null when AUTH_SECRET is not set. */
export function getPortalAuth(env: Record<string, string | undefined> = process.env): PortalAuth | null {
  if (!isIdentityConfigured(env)) return null;
  const baseURL = env.PORTAL_PUBLIC_URL?.trim() || (env.NODE_ENV === 'production' ? '' : 'http://localhost:4321');
  if (!baseURL) throw new Error('PORTAL_PUBLIC_URL is required for sign-in');
  const github = githubSignInConfigured(env) ? { clientId: env.GITHUB_SIGNIN_CLIENT_ID!.trim(), clientSecret: env.GITHUB_SIGNIN_CLIENT_SECRET!.trim() } : undefined;
  const key = JSON.stringify([env.AUTH_SECRET, baseURL, github?.clientId]);
  if (cached?.key !== key) cached = { key, auth: createPortalAuth({ secret: env.AUTH_SECRET!.trim(), baseURL, github }) };
  return cached.auth;
}

/** Test-only: forget the cached instance. */
export function _resetPortalAuthForTests(): void {
  cached = null;
}

function isLocalOrigin(origin: string): boolean {
  const { hostname, protocol } = new URL(origin);
  return protocol === 'http:' && (hostname === 'localhost' || hostname === '127.0.0.1' || hostname.endsWith('.localhost'));
}
