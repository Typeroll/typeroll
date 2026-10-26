// Logout revokes the Firebase refresh tokens of a real session so a copied
// session cookie stops working (getSession verifies with checkRevoked).
// Dev and E2E identities never reach Firebase.
vi.mock('../../lib/datastore', () => ({ getStore: () => ({ getDoc: async () => null, listDocs: async () => [] }) }));
import { beforeEach, expect, it, vi } from 'vitest';
const verify = vi.hoisted(() => vi.fn());
const revoke = vi.hoisted(() => vi.fn());
const configured = vi.hoisted(() => ({ value: true }));
vi.mock('firebase-admin/auth', () => ({ getAuth: () => ({ verifySessionCookie: verify, revokeRefreshTokens: revoke }) }));
vi.mock('../../lib/firebase-admin', () => ({ getFirebaseAdminApp: async () => ({}), isFirebaseAdminConfigured: () => configured.value }));
import { POST } from '../../pages/api/auth/logout';

function logout(cookie: string | undefined) {
  const cookies = { get: (name: string) => (name === 'typeroll_session' && cookie ? { value: cookie } : undefined), delete: vi.fn(), set: vi.fn() };
  const redirect = (to: string) => new Response(null, { status: 302, headers: { Location: to } });
  return { cookies, response: POST({ cookies, redirect, request: new Request('https://portal.test/api/auth/logout', { method: 'POST' }) } as never) as Promise<Response> };
}

beforeEach(() => {
  verify.mockReset();
  revoke.mockReset();
  configured.value = true;
});

it('revokes the refresh tokens of a verified Firebase session and clears the cookie', async () => {
  verify.mockResolvedValue({ uid: 'firebase-user', email: 'person@example.invalid', email_verified: true });
  const { cookies, response } = logout('synthetic-session');
  expect((await response).status).toBe(302);
  expect(verify).toHaveBeenCalledWith('synthetic-session', true);
  expect(revoke).toHaveBeenCalledExactlyOnceWith('firebase-user');
  expect(cookies.delete).toHaveBeenCalledWith('typeroll_session', { path: '/' });
});

it('still signs out when revocation fails', async () => {
  verify.mockResolvedValue({ uid: 'firebase-user', email: 'person@example.invalid', email_verified: true });
  revoke.mockRejectedValue(new Error('network'));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const { cookies, response } = logout('synthetic-session');
  expect((await response).status).toBe(302);
  expect(cookies.delete).toHaveBeenCalled();
});

it('revokes nothing for an invalid cookie or the local dev session', async () => {
  verify.mockRejectedValue(new Error('invalid'));
  expect((await logout('forged').response).status).toBe(302);
  configured.value = false;
  expect((await logout(undefined).response).status).toBe(302);
  expect(revoke).not.toHaveBeenCalled();
});
