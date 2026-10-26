// Sign-out revokes one Firebase sign-in server-side: copies of the cookie and
// cookies re-minted from it by the rolling refresh stop working, while the
// person's other sign-ins and OAuth/MCP keys (Firebase refresh tokens) are
// untouched.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Doc = Record<string, any>;
const state = vi.hoisted(() => ({
  docs: new Map<string, Record<string, any>>(),
  failReads: false,
  nextAuthTime: 0,
}));

vi.mock('../../lib/datastore', () => ({
  getStore: () => ({
    getDoc: async (path: string) => {
      if (state.failReads) throw new Error('datastore unavailable');
      const doc = state.docs.get(path);
      return doc ? { id: path.split('/').pop(), ...doc } : null;
    },
    setDoc: async (path: string, data: Doc) => { state.docs.set(path, structuredClone(data)); },
    listDocs: async (collection: string, opts: { filters?: Array<{ field: string; value: unknown }> } = {}) =>
      [...state.docs.entries()]
        .filter(([path]) => path.startsWith(`${collection}/`) && path.split('/').length === collection.split('/').length + 1)
        .map(([path, doc]) => ({ id: path.split('/').pop(), ...doc }))
        .filter((doc) => (opts.filters ?? []).every((f) => (doc as Doc)[f.field] === f.value)),
  }),
}));

vi.mock('../../lib/organization-session', () => ({
  resolveOrganizationSession: async (_cookies: unknown, session: Doc) => ({ ...session, orgId: session.orgId ?? 'org-1' }),
  clearOrganization: () => {},
}));
vi.mock('../../lib/firebase-admin', () => ({ getFirebaseAdminApp: async () => ({}), isFirebaseAdminConfigured: () => true }));

// Synthetic Firebase: a session cookie is `cookie:<uid>:<auth_time>`, an ID
// token `id:<uid>:<auth_time>`. createSessionCookie keeps the token's
// auth_time, like Firebase does.
const auth = vi.hoisted(() => {
  const parse = (value: string, prefix: string) => {
    const [kind, uid, authTime] = value.split(':');
    if (kind !== prefix || !uid) throw Object.assign(new Error('invalid'), { code: 'auth/argument-error' });
    return { uid, auth_time: Number(authTime), email: `${uid}@example.invalid`, email_verified: true, org_id: 'org-1', exp: Math.floor(Date.now() / 1000) + 86_400 };
  };
  return {
    verifySessionCookie: vi.fn(async (cookie: string) => parse(cookie, 'cookie')),
    verifyIdToken: vi.fn(async (token: string) => parse(token, 'id')),
    createSessionCookie: vi.fn(async (token: string) => `cookie:${token.split(':').slice(1).join(':')}`),
    createCustomToken: vi.fn(async (uid: string) => `custom-${uid}`),
    revokeRefreshTokens: vi.fn(),
  };
});
vi.mock('firebase-admin/auth', () => ({ getAuth: () => auth }));

import { getSession, getSessionIdentity, refreshSessionForUser, revokeCurrentSession, setSessionFromIdToken } from '../../lib/auth';
import { isSignInRevoked, revokeSignIn, signInKey } from '../../lib/session-revocation';
import { POST as logout } from '../../pages/api/auth/logout';
import { POST as refreshSessionRoute } from '../../pages/api/auth/refresh-session';

function jar(value?: string) {
  const values = new Map<string, string>(value ? [['typeroll_session', value]] : []);
  return {
    get: (name: string) => (values.has(name) ? { value: values.get(name)! } : undefined),
    set: vi.fn((name: string, v: string) => { values.set(name, v); }),
    delete: vi.fn((name: string) => { values.delete(name); }),
    value: () => values.get('typeroll_session'),
  };
}

async function signOut(cookies: ReturnType<typeof jar>) {
  return logout({ cookies, redirect: (to: string) => new Response(null, { status: 302, headers: { Location: to } }) } as never);
}

const T0 = Math.floor(Date.now() / 1000) - 3 * 86_400;

beforeEach(() => {
  state.docs.clear();
  state.failReads = false;
  state.nextAuthTime = T0 + 2 * 86_400;
  vi.clearAllMocks();
  process.env.PUBLIC_FIREBASE_API_KEY = 'synthetic-api-key';
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body: string }) => {
    const uid = String(JSON.parse(init.body).token).replace(/^custom-/, '');
    const authTime = state.nextAuthTime++;
    return new Response(JSON.stringify({ idToken: `id:${uid}:${authTime}` }), { status: 200 });
  }));
});
afterEach(() => { vi.unstubAllGlobals(); delete process.env.PUBLIC_FIREBASE_API_KEY; });

describe('sign-out revocation', () => {
  it('revokes the signed-out sign-in for a copied cookie', async () => {
    const browser = jar(`cookie:user-1:${T0}`);
    const stolenCopy = jar(`cookie:user-1:${T0}`);
    expect(await getSession(stolenCopy as never)).toMatchObject({ userId: 'user-1' });

    const response = await signOut(browser);
    expect(response.status).toBe(302);
    expect(browser.value()).toBeUndefined();
    // Each request has its own cookies object (Astro), so the next request re-checks.
    const nextRequest = jar(stolenCopy.value());
    expect(await getSession(nextRequest as never)).toBeNull();
    expect(await getSessionIdentity(nextRequest as never)).toBeNull();
  });

  it('verifies the cookie and reads the denylist once per request', async () => {
    const request = jar(`cookie:user-1:${T0}`);
    const reads = vi.spyOn(state.docs, 'get');
    for (let i = 0; i < 3; i++) {
      expect(await getSession(request as never)).toMatchObject({ userId: 'user-1' });
      expect(await getSessionIdentity(request as never)).toMatchObject({ userId: 'user-1' });
    }
    expect(auth.verifySessionCookie).toHaveBeenCalledTimes(1);
    expect(reads.mock.calls.filter(([path]) => String(path).startsWith('revoked_sessions/'))).toHaveLength(1);
    // A new request checks again and sees a sign-out made in between.
    await revokeSignIn(signInKey({ uid: 'user-1', auth_time: T0 })!);
    expect(await getSession(jar(`cookie:user-1:${T0}`) as never)).toBeNull();
    expect(auth.verifySessionCookie).toHaveBeenCalledTimes(2);
    // Signing out within a request applies to later reads in that request.
    const own = jar(`cookie:user-1:${T0 + 600}`);
    expect(await getSession(own as never)).not.toBeNull();
    expect(await revokeCurrentSession(own as never)).toBe(true);
    expect(await getSession(own as never)).toBeNull();
    // A cookie replaced during the request is verified again.
    const replaced = jar(`cookie:user-2:${T0}`);
    expect(await getSession(replaced as never)).toMatchObject({ userId: 'user-2' });
    replaced.set('typeroll_session', `cookie:user-3:${T0}`);
    expect(await getSession(replaced as never)).toMatchObject({ userId: 'user-3' });
    reads.mockRestore();
  });

  it('refuses to re-mint a signed-out cookie', async () => {
    const stolenCopy = jar(`cookie:user-1:${T0}`);
    await signOut(jar(`cookie:user-1:${T0}`));

    await expect(refreshSessionForUser(stolenCopy as never, 'user-1', 'synthetic-api-key')).rejects.toThrow('signed out');
    expect(stolenCopy.set).not.toHaveBeenCalled();
    expect(auth.createSessionCookie).not.toHaveBeenCalled();
    const routeResponse = await refreshSessionRoute({ cookies: stolenCopy } as never);
    expect(routeResponse.status).toBe(401);
    expect(stolenCopy.value()).toBe(`cookie:user-1:${T0}`);
  });

  it('revokes copies taken before and after the rolling refresh', async () => {
    const browser = jar(`cookie:user-1:${T0}`);
    const copyBeforeRefresh = jar(`cookie:user-1:${T0}`);

    // The rolling refresh is a new Firebase sign-in with a new auth_time.
    await refreshSessionForUser(browser as never, 'user-1', 'synthetic-api-key');
    const refreshed = browser.value()!;
    expect(refreshed).not.toBe(`cookie:user-1:${T0}`);
    const copyAfterRefresh = jar(refreshed);
    // The old copy refreshes itself independently before sign-out.
    await refreshSessionForUser(copyBeforeRefresh as never, 'user-1', 'synthetic-api-key');
    const attackerRefreshed = jar(copyBeforeRefresh.value());
    for (const cookies of [browser, copyAfterRefresh, attackerRefreshed]) {
      expect(await getSession(cookies as never)).not.toBeNull();
    }

    await signOut(browser);

    // Later requests, each with its own cookies object.
    for (const value of [copyAfterRefresh.value(), attackerRefreshed.value(), `cookie:user-1:${T0}`]) {
      expect(await getSession(jar(value) as never)).toBeNull();
    }
    await expect(refreshSessionForUser(jar(attackerRefreshed.value()) as never, 'user-1', 'synthetic-api-key')).rejects.toThrow('signed out');
  });

  it('keeps the same person\'s other sign-ins and other people signed in', async () => {
    const otherDevice = jar(`cookie:user-1:${T0 + 600}`);
    const otherPerson = jar(`cookie:user-2:${T0}`);
    await signOut(jar(`cookie:user-1:${T0}`));

    expect(await getSession(otherDevice as never)).toMatchObject({ userId: 'user-1' });
    expect(await getSession(otherPerson as never)).toMatchObject({ userId: 'user-2' });
    await refreshSessionForUser(otherDevice as never, 'user-1', 'synthetic-api-key');
    expect(await getSession(otherDevice as never)).toMatchObject({ userId: 'user-1' });
  });

  it('never revokes Firebase refresh tokens, which OAuth and MCP keys depend on', async () => {
    await signOut(jar(`cookie:user-1:${T0}`));
    expect(auth.revokeRefreshTokens).not.toHaveBeenCalled();
    expect([...state.docs.keys()].every((path) => path.startsWith('revoked_sessions/'))).toBe(true);
    expect([...state.docs.keys()].some((path) => path.startsWith('revoked_sessions/'))).toBe(true);
  });

  it('refuses to exchange a signed-out sign-in for a new cookie', async () => {
    const authTime = Math.floor(Date.now() / 1000) - 10;
    await signOut(jar(`cookie:user-1:${authTime}`));
    const cookies = jar();
    await expect(setSessionFromIdToken(cookies as never, `id:user-1:${authTime}`)).rejects.toThrow('signed out');
    expect(cookies.set).not.toHaveBeenCalled();
  });

  it('fails closed when the denylist cannot be read', async () => {
    const cookies = jar(`cookie:user-1:${T0}`);
    state.failReads = true;
    expect(await getSession(cookies as never)).toBeNull();
  });

  it('only clears the cookie for local development and E2E sessions', async () => {
    const cookies = jar('dev');
    await signOut(cookies);
    expect(cookies.value()).toBeUndefined();
    expect(state.docs.size).toBe(0);
    expect(auth.verifySessionCookie).not.toHaveBeenCalled();
    expect(await revokeCurrentSession(jar() as never)).toBe(false);
  });

  it('expires revocation entries after the longest remaining cookie lifetime', async () => {
    const now = Date.UTC(2026, 9, 26);
    const key = signInKey({ uid: 'user-1', auth_time: T0 })!;
    await revokeSignIn(key, now);
    const record = state.docs.get(`revoked_sessions/${key}`)!;
    // A native timestamp for the Firestore TTL policy, at least 14 days out.
    expect(record.expires_at).toBeInstanceOf(Date);
    expect(record.expires_at.getTime()).toBe(record.expires_at_ms);
    expect(record.expires_at_ms).toBeGreaterThanOrEqual(now + 14 * 86_400_000);
    expect(await isSignInRevoked(key, now + 14 * 86_400_000)).toBe(true);
    expect(await isSignInRevoked(key, now + 15 * 86_400_000)).toBe(false);
  });
});
