// The server-side email confirmation gate for real Firebase identities.
// Firebase session cookies repeat the claims of the ID token they were minted
// from, so the decision is made from `email_verified` on every request.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const store = vi.hoisted(() => ({ getDoc: vi.fn(async () => null), listDocs: vi.fn(async () => []), createDocIfMissing: vi.fn() }));
vi.mock('../../lib/datastore', () => ({ getStore: () => store }));
const admin = vi.hoisted(() => ({
  verifySessionCookie: vi.fn(), verifyIdToken: vi.fn(), createSessionCookie: vi.fn(async () => 'minted-cookie'),
  createCustomToken: vi.fn(async () => 'custom-token'), getUser: vi.fn(),
}));
vi.mock('firebase-admin/auth', () => ({ getAuth: () => admin }));
vi.mock('../../lib/firebase-admin', () => ({ getFirebaseAdminApp: async () => ({}), isFirebaseAdminConfigured: () => true }));
vi.mock('../../lib/auth-request', async (original) => ({
  ...await original<typeof import('../../lib/auth-request')>(),
  limitAuthRequest: async () => null,
}));
import { getSession, getSessionIdentity, hasConfirmedEmail, setSessionFromIdToken } from '../../lib/auth';
import { confirmEmailVerification, sendVerificationEmail, verificationContinueUrl } from '../../lib/email-verification';
import { POST as exchange } from '../../pages/api/auth/session';

const now = () => Math.floor(Date.now() / 1000);
const cookieJar = () => ({ get: vi.fn((name: string) => name === 'typeroll_session' ? { value: 'session-cookie' } : undefined), set: vi.fn(), delete: vi.fn() });
const claims = (extra: Record<string, unknown>) => ({ uid: 'person', email: 'person@example.test', org_id: 'acme', exp: now() + 3600, auth_time: now(), ...extra });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('PUBLIC_FIREBASE_API_KEY', 'public-web-api-key');
  vi.stubEnv('PORTAL_PUBLIC_URL', 'https://cms.example.test');
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('hasConfirmedEmail', () => {
  it.each([
    ['password, confirmed', { email: 'a@example.test', email_verified: true }, true],
    ['password, unconfirmed', { email: 'a@example.test', email_verified: false }, false],
    ['github.com with an address Firebase confirmed', { email: 'a@example.test', email_verified: true, firebase: { sign_in_provider: 'github.com' } }, true],
    ['github.com as Firebase reports it by default', { email: 'a@example.test', email_verified: false, firebase: { sign_in_provider: 'github.com' } }, false],
    ['older cookie without the claim', { email: 'a@example.test' }, false],
    ['truthy non-boolean claim', { email: 'a@example.test', email_verified: 'true' }, false],
    ['no email address', { email_verified: true }, false],
    ['empty email address', { email: '', email_verified: true }, false],
  ])('%s', (_name, input, expected) => expect(hasConfirmedEmail(input)).toBe(expected));
});

describe('session reads', () => {
  it('returns a confirmed session with its Organization', async () => {
    admin.verifySessionCookie.mockResolvedValue(claims({ email_verified: true, firebase: { sign_in_provider: 'password' } }));
    expect(await getSession(cookieJar() as never)).toMatchObject({ userId: 'person', orgId: 'acme', emailVerified: true, signInProvider: 'password' });
    expect(admin.verifySessionCookie).toHaveBeenCalledWith('session-cookie', true);
  });

  it.each([
    ['unconfirmed password account', { email_verified: false, firebase: { sign_in_provider: 'password' } }],
    ['unconfirmed GitHub account', { email_verified: false, firebase: { sign_in_provider: 'github.com' } }],
    ['session issued before the gate without the claim', {}],
  ])('rejects a %s everywhere but exposes the pending identity', async (_name, extra) => {
    admin.verifySessionCookie.mockResolvedValue(claims(extra));
    expect(await getSession(cookieJar() as never)).toBeNull();
    const identity = await getSessionIdentity(cookieJar() as never);
    expect(identity).toMatchObject({ userId: 'person', email: 'person@example.test', emailVerified: false, orgId: undefined });
    // Memberships are not resolved, remembered or selected for it.
    expect(store.getDoc).not.toHaveBeenCalled();
    expect(store.listDocs).not.toHaveBeenCalled();
    expect(store.createDocIfMissing).not.toHaveBeenCalled();
  });

  it('accepts a confirmed GitHub account', async () => {
    admin.verifySessionCookie.mockResolvedValue(claims({ email_verified: true, firebase: { sign_in_provider: 'github.com' } }));
    expect(await getSession(cookieJar() as never)).toMatchObject({ emailVerified: true, signInProvider: 'github.com' });
  });
});

describe('session exchange', () => {
  it('issues a pending cookie for an unconfirmed account and reports that confirmation is required', async () => {
    admin.verifyIdToken.mockResolvedValue(claims({ email_verified: false, firebase: { sign_in_provider: 'github.com' } }));
    const cookies = cookieJar();
    const identity = await setSessionFromIdToken(cookies as never, 'id-token');
    expect(identity).toMatchObject({ emailVerified: false, orgId: undefined });
    expect(cookies.set).toHaveBeenCalledWith('typeroll_session', 'minted-cookie', expect.objectContaining({ httpOnly: true }));

    const response = await exchange({ cookies: cookieJar(), clientAddress: '192.0.2.1', request: new Request('https://cms.example.test/api/auth/session', {
      method: 'POST', headers: { Origin: 'https://cms.example.test', 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken: 'id-token' }),
    }) } as never) as Response;
    expect(await response.json()).toMatchObject({ ok: true, verificationRequired: true });
  });

  it('does not require confirmation for a confirmed account', async () => {
    admin.verifyIdToken.mockResolvedValue(claims({ email_verified: true }));
    const response = await exchange({ cookies: cookieJar(), clientAddress: '192.0.2.1', request: new Request('https://cms.example.test/api/auth/session', {
      method: 'POST', headers: { Origin: 'https://cms.example.test', 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken: 'id-token' }),
    }) } as never) as Response;
    expect(await response.json()).toMatchObject({ ok: true, verificationRequired: false });
  });
});

describe('confirmation email and re-check', () => {
  const pending = { userId: 'person', email: 'person@example.test', orgId: undefined, emailVerified: false, authSource: 'firebase' as const };

  it('builds the continue URL on the portal origin with the sanitized continuation', () => {
    expect(verificationContinueUrl('https://cms.example.test', '/onboarding?invite=abc'))
      .toBe('https://cms.example.test/verify-email?next=%2Fonboarding%3Finvite%3Dabc');
    expect(verificationContinueUrl('https://cms.example.test', null)).toBe('https://cms.example.test/verify-email');
  });

  it('sends Firebase\'s confirmation email and falls back when the continue domain is not authorized', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ idToken: 'server-id-token' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'UNAUTHORIZED_DOMAIN : Domain not allowlisted by project' } }), { status: 400 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ email: 'person@example.test' })));
    vi.stubGlobal('fetch', fetchMock);
    expect(await sendVerificationEmail(pending, 'https://cms.example.test/verify-email')).toBe('sent');
    expect(admin.createCustomToken).toHaveBeenCalledWith('person');
    const first = JSON.parse(fetchMock.mock.calls[1][1].body);
    const second = JSON.parse(fetchMock.mock.calls[2][1].body);
    expect(fetchMock.mock.calls[1][0]).toContain('accounts:sendOobCode');
    expect(first).toEqual({ requestType: 'VERIFY_EMAIL', idToken: 'server-id-token', continueUrl: 'https://cms.example.test/verify-email' });
    expect(second).toEqual({ requestType: 'VERIFY_EMAIL', idToken: 'server-id-token' });
    vi.unstubAllGlobals();
  });

  it('maps Firebase throttling and skips identities without a Firebase account', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ idToken: 'server-id-token' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'TOO_MANY_ATTEMPTS_TRY_LATER' } }), { status: 400 })));
    expect(await sendVerificationEmail(pending, 'https://cms.example.test/verify-email')).toBe('throttled');
    vi.unstubAllGlobals();
    expect(await sendVerificationEmail({ ...pending, authSource: 'e2e' }, 'x')).toBe('skipped');
  });

  it('re-mints the session only after Firebase reports the address confirmed', async () => {
    admin.getUser.mockResolvedValueOnce({ email: 'person@example.test', emailVerified: false, disabled: false });
    const cookies = cookieJar();
    expect(await confirmEmailVerification(cookies as never, pending)).toBe(false);
    expect(cookies.set).not.toHaveBeenCalled();

    admin.getUser.mockResolvedValueOnce({ email: 'person@example.test', emailVerified: true, disabled: false });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ idToken: 'fresh-id-token' }))));
    expect(await confirmEmailVerification(cookies as never, pending)).toBe(true);
    expect(admin.createSessionCookie).toHaveBeenCalledWith('fresh-id-token', expect.any(Object));
    expect(cookies.set).toHaveBeenCalledWith('typeroll_session', 'minted-cookie', expect.objectContaining({ httpOnly: true, sameSite: 'lax' }));
    vi.unstubAllGlobals();

    admin.getUser.mockResolvedValueOnce({ email: 'person@example.test', emailVerified: true, disabled: true });
    expect(await confirmEmailVerification(cookieJar() as never, pending)).toBe(false);
  });
});
