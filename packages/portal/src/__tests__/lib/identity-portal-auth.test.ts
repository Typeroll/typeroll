// The portal's Better Auth instance end to end over the SQL document store:
// sign-up, confirmation, sign-in, sign-out, reset, rate limit, disabled users
// and the store adapter's atomic guarantees.
import { beforeEach, describe, expect, it } from 'vitest';
import type { ReadWriteStore } from '../../lib/datastore';
import { Browser, ORIGIN, memoryStore } from '../helpers/identity';
import { createPortalAuth, type PortalAuth } from '../../lib/identity/portal-auth';
import { _setAccountMailSenderForTests, type AccountMail } from '../../lib/identity/account-mail';

const SECRET = 'test-auth-secret-0123456789abcdef-0123456789';
let store: ReadWriteStore;
let auth: PortalAuth;
let mail: AccountMail[];

async function session(browser: Browser) {
  const response = await browser.request('/api/auth/get-session');
  return response.json() as Promise<{ user: { id: string; email: string; emailVerified: boolean }; session: { id: string } } | null>;
}

function linkFrom(message: AccountMail): string {
  const url = message.text.match(/https?:\/\/\S+/)?.[0];
  if (!url) throw new Error('no link in mail');
  return url.replace(ORIGIN, '');
}

beforeEach(() => {
  store = memoryStore();
  auth = createPortalAuth({ secret: SECRET, baseURL: ORIGIN, store: () => store });
  mail = [];
  _setAccountMailSenderForTests(async message => { mail.push(message); });
});

describe('portal sign-in', () => {
  it('signs up, sends a confirmation link and marks the address confirmed', async () => {
    const browser = new Browser(auth.handler);
    const signUp = await browser.post('/api/auth/sign-up/email', { email: 'Ada@Example.test', password: 'correct horse battery', name: 'Ada' });
    expect(signUp.status).toBe(200);
    expect((await session(browser))?.user).toMatchObject({ email: 'ada@example.test', emailVerified: false });
    expect(mail).toHaveLength(1);
    expect(mail[0]!.to).toBe('ada@example.test');

    const confirm = await browser.request(linkFrom(mail[0]!));
    expect([200, 302]).toContain(confirm.status);
    expect((await session(browser))?.user.emailVerified).toBe(true);
  });

  it('refuses passwords shorter than 12 characters', async () => {
    const response = await new Browser(auth.handler).post('/api/auth/sign-up/email', { email: 'a@example.test', password: 'short pass', name: 'A' });
    expect(response.status).toBe(400);
  });

  it('allows one account per address under concurrent sign-ups', async () => {
    const results = await Promise.all(Array.from({ length: 5 }, (_, i) =>
      new Browser(auth.handler, `198.51.100.${i}`).post('/api/auth/sign-up/email', { email: 'race@example.test', password: 'correct horse battery', name: 'R' })));
    expect(results.filter(r => r.status === 200)).toHaveLength(1);
    const users = await store.listDocs('auth_user');
    expect(users).toHaveLength(1);
  });

  it('signs in, and sign-out ends the session for every copy of the cookie', async () => {
    await new Browser(auth.handler).post('/api/auth/sign-up/email', { email: 'b@example.test', password: 'correct horse battery', name: 'B' });
    const browser = new Browser(auth.handler);
    expect((await browser.post('/api/auth/sign-in/email', { email: 'b@example.test', password: 'correct horse battery' })).status).toBe(200);
    const copy = new Browser(auth.handler);
    copy.cookies = new Map(browser.cookies);
    expect(await session(copy)).not.toBeNull();
    expect((await browser.post('/api/auth/sign-out')).status).toBe(200);
    expect(await session(copy)).toBeNull();
  });

  it('rejects a wrong password without revealing whether the account exists', async () => {
    await new Browser(auth.handler).post('/api/auth/sign-up/email', { email: 'c@example.test', password: 'correct horse battery', name: 'C' });
    const wrong = await new Browser(auth.handler).post('/api/auth/sign-in/email', { email: 'c@example.test', password: 'wrong horse battery' });
    const missing = await new Browser(auth.handler).post('/api/auth/sign-in/email', { email: 'nobody@example.test', password: 'wrong horse battery' });
    expect(wrong.status).toBe(401);
    expect(missing.status).toBe(401);
    expect(await wrong.json()).toEqual(await missing.json());
  });

  it('resets a password with a single-use link and signs out every session', async () => {
    const first = new Browser(auth.handler);
    await first.post('/api/auth/sign-up/email', { email: 'd@example.test', password: 'correct horse battery', name: 'D' });
    mail = [];
    expect((await new Browser(auth.handler).post('/api/auth/request-password-reset', { email: 'd@example.test', redirectTo: '/reset-password' })).status).toBe(200);
    const link = new URL(linkFrom(mail[0]!), ORIGIN);
    const redirect = await new Browser(auth.handler).request(`${link.pathname}${link.search}`);
    const token = new URL(redirect.headers.get('location')!, ORIGIN).searchParams.get('token')
      ?? link.pathname.split('/').pop()!;
    const results = await Promise.all([1, 2].map(() => new Browser(auth.handler).post('/api/auth/reset-password', { token, newPassword: 'a whole new password' })));
    expect(results.map(r => r.status).sort()).toEqual([200, 400]);
    expect(await session(first)).toBeNull();
    expect((await new Browser(auth.handler).post('/api/auth/sign-in/email', { email: 'd@example.test', password: 'a whole new password' })).status).toBe(200);
  });

  it('limits sign-in attempts per client address', async () => {
    const browser = new Browser(auth.handler, '192.0.2.99');
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push((await browser.post('/api/auth/sign-in/email', { email: 'e@example.test', password: 'wrong horse battery' })).status);
    expect(statuses.slice(0, 10).every(s => s === 401)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
    // Another address keeps its own budget.
    expect((await new Browser(auth.handler, '192.0.2.100').post('/api/auth/sign-in/email', { email: 'e@example.test', password: 'wrong horse battery' })).status).toBe(401);
  });

  it('refuses requests from another origin', async () => {
    const response = await auth.handler(new Request(`${ORIGIN}/api/auth/sign-in/email`, {
      method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json', cookie: 'x=y' },
      body: JSON.stringify({ email: 'f@example.test', password: 'correct horse battery' }),
    }));
    expect(response.status).toBe(403);
  });

  it('keeps a disabled person signed out', async () => {
    const browser = new Browser(auth.handler);
    await browser.post('/api/auth/sign-up/email', { email: 'g@example.test', password: 'correct horse battery', name: 'G' });
    const user = (await session(browser))!.user;
    await store.updateDoc(`auth_user/${user.id}`, { disabled: true });
    expect((await new Browser(auth.handler).post('/api/auth/sign-in/email', { email: 'g@example.test', password: 'correct horse battery' })).status).not.toBe(200);
  });
});
