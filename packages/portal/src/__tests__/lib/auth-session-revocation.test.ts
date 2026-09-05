import { beforeEach, expect, it, vi } from 'vitest';
const verify = vi.hoisted(() => vi.fn());
vi.mock('firebase-admin/auth', () => ({ getAuth: () => ({ verifySessionCookie: verify }) }));
vi.mock('../../lib/firebase-admin', () => ({ getFirebaseAdminApp: async () => ({}), isFirebaseAdminConfigured: () => true }));
import { getSession } from '../../lib/auth';
const cookies = { get: () => ({ value: 'synthetic-session' }) };
beforeEach(() => verify.mockReset());

it.each(['auth/user-disabled', 'auth/user-not-found', 'auth/insufficient-permission', 'auth/session-cookie-revoked', 'network-error'])(
  'rejects %s without a verification fallback', async (code) => {
    verify.mockImplementation(async (_cookie, checkRevoked) => {
      if (checkRevoked) throw Object.assign(new Error('Synthetic error'), { code });
      return { uid: 'test-user', org_id: 'test-org' };
    });
    expect(await getSession(cookies as never)).toBeNull();
    expect(verify).toHaveBeenCalledExactlyOnceWith('synthetic-session', true);
  },
);
it('accepts a successfully checked session', async () => {
  verify.mockResolvedValue({ uid: 'test-user', org_id: 'test-org' });
  expect(await getSession(cookies as never)).toMatchObject({ userId: 'test-user', orgId: 'test-org' });
});
