// "Signed in until I log out": two halves.
//
//  1. Transient Firebase failures during the checkRevoked lookup must not
//     log the user out — getSession falls back to local (cryptographic)
//     verification. Definitive errors (revoked, expired) still end the
//     session.
//  2. sessionNeedsRefresh drives the middleware's rolling re-mint so an
//     active user never hits the 14-day session-cookie cap.

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('firebase-admin/auth', () => ({
  getAuth: vi.fn(() => ({
    verifySessionCookie: vi.fn(),
    createSessionCookie: vi.fn(),
    verifyIdToken: vi.fn(),
  })),
}));
vi.mock('firebase-admin/app', () => ({
  initializeApp: vi.fn(),
  cert: vi.fn(),
  applicationDefault: vi.fn(),
  getApps: vi.fn(() => []),
}));

const DECODED = { uid: 'user-1', email: 'a@b.se', org_id: 'org-1', exp: Math.floor(Date.now() / 1000) + 14 * 86400 };

function cookiesWith(value: string) {
  return { get: vi.fn(() => ({ value })), set: vi.fn(), delete: vi.fn() } as any;
}

describe('getSession resilience', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.FIREBASE_SERVICE_ACCOUNT = JSON.stringify({ project_id: 'test', type: 'service_account' });
  });

  it('falls back to local verification when the revocation lookup fails transiently', async () => {
    const { getAuth } = await import('firebase-admin/auth');
    const verify = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('network'), { code: 'auth/internal-error' }))
      .mockResolvedValueOnce(DECODED);
    (getAuth as ReturnType<typeof vi.fn>).mockReturnValue({ verifySessionCookie: verify });

    const { getSession } = await import('../../lib/auth');
    const session = await getSession(cookiesWith('valid-cookie'));
    expect(session?.userId).toBe('user-1');
    // First call with checkRevoked=true, fallback without.
    expect(verify).toHaveBeenNthCalledWith(1, 'valid-cookie', true);
    expect(verify).toHaveBeenNthCalledWith(2, 'valid-cookie', false);
  });

  it('still logs out on an explicit revocation', async () => {
    const { getAuth } = await import('firebase-admin/auth');
    const verify = vi.fn().mockRejectedValue(
      Object.assign(new Error('revoked'), { code: 'auth/session-cookie-revoked' }),
    );
    (getAuth as ReturnType<typeof vi.fn>).mockReturnValue({ verifySessionCookie: verify });

    const { getSession } = await import('../../lib/auth');
    expect(await getSession(cookiesWith('revoked-cookie'))).toBeNull();
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it('logs out when the cookie fails local verification too (expired/forged)', async () => {
    const { getAuth } = await import('firebase-admin/auth');
    const verify = vi.fn().mockRejectedValue(
      Object.assign(new Error('expired'), { code: 'auth/session-cookie-expired' }),
    );
    (getAuth as ReturnType<typeof vi.fn>).mockReturnValue({ verifySessionCookie: verify });

    const { getSession } = await import('../../lib/auth');
    expect(await getSession(cookiesWith('expired-cookie'))).toBeNull();
  });

  it('exposes the cookie expiry for the rolling-refresh check', async () => {
    const { getAuth } = await import('firebase-admin/auth');
    (getAuth as ReturnType<typeof vi.fn>).mockReturnValue({
      verifySessionCookie: vi.fn().mockResolvedValue(DECODED),
    });
    const { getSession } = await import('../../lib/auth');
    const session = await getSession(cookiesWith('valid'));
    expect(session?.expiresAtMs).toBe(DECODED.exp * 1000);
  });
});

describe('sessionNeedsRefresh', () => {
  beforeEach(() => { vi.resetModules(); });

  it('is false for a freshly minted cookie', async () => {
    const { sessionNeedsRefresh, SESSION_LIFETIME_MS } = await import('../../lib/auth');
    const now = 1_000_000_000_000;
    const fresh = { userId: 'u', email: '', orgId: 'o', expiresAtMs: now + SESSION_LIFETIME_MS };
    expect(sessionNeedsRefresh(fresh, now)).toBe(false);
  });

  it('is true once the cookie has burned more than a day', async () => {
    const { sessionNeedsRefresh, SESSION_LIFETIME_MS } = await import('../../lib/auth');
    const now = 1_000_000_000_000;
    const dayOld = { userId: 'u', email: '', orgId: 'o', expiresAtMs: now + SESSION_LIFETIME_MS - 25 * 3600 * 1000 };
    expect(sessionNeedsRefresh(dayOld, now)).toBe(true);
  });

  it('is false for sessions without expiry info (dev session)', async () => {
    const { sessionNeedsRefresh } = await import('../../lib/auth');
    expect(sessionNeedsRefresh({ userId: 'u', email: '', orgId: 'o' })).toBe(false);
  });
});
