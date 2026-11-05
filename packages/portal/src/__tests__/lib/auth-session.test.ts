// lib/auth.ts over real Better Auth sessions in the test datastore: the email
// gate, Organization resolution, pending sessions, disabled people, sign-out
// for copies of a cookie, and development/E2E fallbacks.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AstroCookies } from 'astro';
import { paths } from '@typeroll/shared';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { Browser, ORIGIN } from '../helpers/identity';
import { getStore } from '../../lib/datastore';
import { clearSession, getSession, getSessionIdentity, isDevAuthEnabled, isPendingSession, revokeCurrentSession } from '../../lib/auth';
import { getPortalAuth, _resetPortalAuthForTests } from '../../lib/identity/portal-auth';
import { _setAccountMailSenderForTests, type AccountMail } from '../../lib/identity/account-mail';
import { sendVerificationEmail } from '../../lib/email-verification';
import { createE2ESessionCookie } from '../../lib/e2e-auth';

const env = { ...process.env };
let mail: AccountMail[];

/** Astro's cookies for one request, backed by a browser's cookie jar. */
function requestCookies(jar: Map<string, string>) {
  return {
    get: (name: string, options?: { decode?: (v: string) => string }) => {
      const value = jar.get(name);
      return value === undefined ? undefined : { value: options?.decode ? options.decode(value) : decodeURIComponent(value) };
    },
    set: (name: string, value: string, options?: { encode?: (v: string) => string }) => { jar.set(name, options?.encode ? options.encode(value) : encodeURIComponent(value)); },
    delete: (name: string) => { jar.delete(name); },
    has: (name: string) => jar.has(name),
  } as unknown as AstroCookies;
}

async function signUp(email: string, name = 'Person') {
  const browser = new Browser(getPortalAuth()!.handler);
  expect((await browser.post('/api/auth/sign-up/email', { email, password: 'correct horse battery', name })).status).toBe(200);
  return browser;
}

async function confirm(browser: Browser) {
  const link = mail.at(-1)!.text.match(/https?:\/\/\S+/)![0]!.replace(ORIGIN, '');
  await browser.request(link);
}

beforeEach(async () => {
  makeTmpFixtures();
  await resetDatastore();
  process.env.AUTH_SECRET = 'test-auth-secret-0123456789abcdef-0123456789';
  process.env.PORTAL_PUBLIC_URL = ORIGIN;
  _resetPortalAuthForTests();
  mail = [];
  _setAccountMailSenderForTests(async message => { mail.push(message); });
});
afterEach(() => {
  for (const key of ['AUTH_SECRET', 'PORTAL_PUBLIC_URL', 'NODE_ENV', 'TYPEROLL_E2E_AUTH_SECRET'] as const) {
    if (env[key] === undefined) delete process.env[key]; else process.env[key] = env[key];
  }
  _resetPortalAuthForTests();
  _setAccountMailSenderForTests(null);
});

describe('account sessions', () => {
  it('treats an unconfirmed account as signed out except for its identity', async () => {
    const browser = await signUp('new@example.test');
    const cookies = requestCookies(browser.cookies);
    expect(await getSession(cookies)).toBeNull();
    expect(await getSessionIdentity(requestCookies(browser.cookies))).toMatchObject({ email: 'new@example.test', emailVerified: false, orgId: undefined, authSource: 'account' });
  });

  it('confirms through the emailed link and resolves the Organization from membership', async () => {
    const browser = await signUp('owner@example.test', 'Owner');
    await confirm(browser);
    const pending = await getSession(requestCookies(browser.cookies));
    expect(pending).toMatchObject({ email: 'owner@example.test', displayName: 'Owner', emailVerified: true, orgId: undefined });
    expect(isPendingSession(pending!)).toBe(true);

    await getStore().setDoc(paths.org('acme'), { name: 'Acme', roles_enforced: true });
    await getStore().setDoc(`${paths.members('acme')}/${pending!.userId}`, { role: 'owner', email: 'owner@example.test' });
    await getStore().setDoc(`user_organizations/${pending!.userId}/organizations/acme`, { org_id: 'acme' });
    expect(await getSession(requestCookies(browser.cookies))).toMatchObject({ orgId: 'acme' });
  });

  it('sends a new confirmation link only for real accounts', async () => {
    const browser = await signUp('again@example.test');
    const identity = (await getSessionIdentity(requestCookies(browser.cookies)))!;
    mail = [];
    expect(await sendVerificationEmail(identity, '/app/sites')).toBe('sent');
    expect(mail[0]!.to).toBe('again@example.test');
    expect(mail[0]!.text).toContain(encodeURIComponent('/verify-email?next=%2Fapp%2Fsites'));
    expect(await sendVerificationEmail({ ...identity, authSource: 'e2e' }, null)).toBe('skipped');
  });

  it('signs out every copy of the cookie and keeps other sessions', async () => {
    const browser = await signUp('out@example.test');
    await confirm(browser);
    const other = new Browser(getPortalAuth()!.handler);
    await other.post('/api/auth/sign-in/email', { email: 'out@example.test', password: 'correct horse battery' });
    const copy = new Map(browser.cookies);

    const cookies = requestCookies(browser.cookies);
    expect(await revokeCurrentSession(cookies)).toBe(true);
    clearSession(cookies);
    expect(await getSession(requestCookies(copy))).toBeNull();
    expect(await getSession(requestCookies(other.cookies))).not.toBeNull();
  });

  it('ends the sessions of a disabled person at once', async () => {
    const browser = await signUp('off@example.test');
    await confirm(browser);
    const session = (await getSession(requestCookies(browser.cookies)))!;
    await getStore().updateDoc(`auth_user/${session.userId}`, { disabled: true });
    expect(await getSessionIdentity(requestCookies(browser.cookies))).toBeNull();
  });

  it('rejects forged and unknown cookies', async () => {
    expect(await getSessionIdentity(requestCookies(new Map([['typeroll.session_token', 'forged.signature']])))).toBeNull();
    expect(await getSessionIdentity(requestCookies(new Map()))).toBeNull();
  });
});

describe('development and E2E identities', () => {
  it('uses the development user only without accounts and outside production', async () => {
    expect(isDevAuthEnabled()).toBe(false);
    delete process.env.AUTH_SECRET;
    expect(isDevAuthEnabled()).toBe(true);
    expect(await getSession(requestCookies(new Map()))).toMatchObject({ userId: 'dev-user', authSource: 'dev' });
    process.env.NODE_ENV = 'production';
    expect(isDevAuthEnabled()).toBe(false);
    expect(await getSession(requestCookies(new Map([['typeroll_session', 'dev']])))).toBeNull();
  });

  it('accepts a signed E2E persona only without accounts', async () => {
    delete process.env.AUTH_SECRET;
    process.env.NODE_ENV = 'test';
    process.env.TYPEROLL_E2E_AUTH_SECRET = 'local-e2e-auth-secret-at-least-32-characters';
    const value = createE2ESessionCookie('owner');
    expect(await getSessionIdentity(requestCookies(new Map([['typeroll_session', value]])))).toMatchObject({ userId: 'typeroll-e2e-owner', authSource: 'e2e' });
    process.env.AUTH_SECRET = 'test-auth-secret-0123456789abcdef-0123456789';
    expect(await getSessionIdentity(requestCookies(new Map([['typeroll_session', value]])))).toBeNull();
  });
});
