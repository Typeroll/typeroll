import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createE2ESessionCookie,
  E2E_SESSION_PERSONAS,
  isE2EAuthEnabled,
  matchesE2EAuthSecret,
  readE2ESessionCookie,
} from '../../lib/e2e-auth';

const KEYS = ['NODE_ENV', 'AUTH_SECRET', 'TYPEROLL_E2E_AUTH_SECRET', 'TYPEROLL_LOCAL_E2E', 'STORE_JURISDICTION', 'PORTAL_PUBLIC_URL'] as const;
const previous = Object.fromEntries(KEYS.map(key => [key, process.env[key]]));

/** The variables tests/e2e/start-worker.mjs gives the local Worker. */
function localE2E(): void {
  delete process.env.AUTH_SECRET;
  process.env.TYPEROLL_LOCAL_E2E = 'allow';
  process.env.STORE_JURISDICTION = 'none';
  process.env.PORTAL_PUBLIC_URL = 'http://127.0.0.1:4322';
  process.env.TYPEROLL_E2E_AUTH_SECRET = 'local-e2e-auth-secret-at-least-32-characters';
}

afterEach(() => {
  for (const key of KEYS) {
    if (previous[key] === undefined) delete process.env[key];
    else process.env[key] = previous[key];
  }
});

describe('local E2E authentication', () => {
  it('stays aligned with the shared Core persona manifest', () => {
    const manifest = JSON.parse(fs.readFileSync(
      new URL('../../../../../config/e2e-personas.json', import.meta.url),
      'utf8',
    )) as { personas: Array<{ id: string; uid?: string; org_id?: string; managed_by: string }> };
    const core = manifest.personas.filter((persona) => persona.managed_by === 'core');
    expect(Object.keys(E2E_SESSION_PERSONAS)).toEqual(core.map((persona) => persona.id));
    for (const persona of core) {
      const session = E2E_SESSION_PERSONAS[persona.id as keyof typeof E2E_SESSION_PERSONAS];
      expect(session.userId).toBe(persona.uid);
      expect(session.orgId).toBe(persona.org_id ?? undefined);
    }
  });

  it('accepts only a signed known persona in local E2E mode', () => {
    localE2E();
    const cookie = createE2ESessionCookie('editor');
    expect(isE2EAuthEnabled()).toBe(true);
    expect(matchesE2EAuthSecret('local-e2e-auth-secret-at-least-32-characters')).toBe(true);
    expect(matchesE2EAuthSecret('wrong-e2e-auth-secret-at-least-32-characters')).toBe(false);
    expect(readE2ESessionCookie(cookie)).toEqual({ ...E2E_SESSION_PERSONAS.editor, emailVerified: true });
    expect(readE2ESessionCookie(cookie.replace('editor', 'owner'))).toBeNull();
    expect(readE2ESessionCookie('e2e.unknown.invalid')).toBeNull();
  });

  it('signs an unconfirmed-email variant that cannot be upgraded by editing the cookie', () => {
    localE2E();
    const unverified = createE2ESessionCookie('owner', { emailVerified: false });
    expect(readE2ESessionCookie(unverified)).toEqual({ ...E2E_SESSION_PERSONAS.owner, emailVerified: false });
    const [prefix, persona, , sig] = unverified.split('.');
    expect(readE2ESessionCookie(`${prefix}.${persona}.${sig}`)).toBeNull();
    const verifiedSig = createE2ESessionCookie('owner').split('.')[2];
    expect(readE2ESessionCookie(`${prefix}.${persona}.unverified.${verifiedSig}`)).toBeNull();
    expect(readE2ESessionCookie(`${prefix}.${persona}.other.${sig}`)).toBeNull();
  });

  it('is enabled by local E2E mode regardless of NODE_ENV, which the Worker build fixes to production', () => {
    localE2E();
    for (const mode of ['production', 'test', undefined]) {
      if (mode === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = mode;
      expect(isE2EAuthEnabled()).toBe(true);
    }
  });

  it.each([
    ['without the explicit switch', () => { delete process.env.TYPEROLL_LOCAL_E2E; }],
    ['with another switch value', () => { process.env.TYPEROLL_LOCAL_E2E = 'true'; }],
    ['when accounts are configured', () => { process.env.AUTH_SECRET = 'real-auth-secret-0123456789abcdef-0123456789'; }],
    ['with any AUTH_SECRET, even an unusable one', () => { process.env.AUTH_SECRET = 'short'; }],
    ['in the EU store jurisdiction of a deployed Worker', () => { process.env.STORE_JURISDICTION = 'eu'; }],
    ['without a store jurisdiction setting', () => { delete process.env.STORE_JURISDICTION; }],
    ['on a public portal origin', () => { process.env.PORTAL_PUBLIC_URL = 'https://app.typeroll.com'; }],
    ['on a look-alike loopback host', () => { process.env.PORTAL_PUBLIC_URL = 'http://127.0.0.1.example.test'; }],
    ['without a portal origin', () => { delete process.env.PORTAL_PUBLIC_URL; }],
    ['with a short secret', () => { process.env.TYPEROLL_E2E_AUTH_SECRET = 'too-short'; }],
    ['under NODE_ENV=test alone', () => { delete process.env.TYPEROLL_LOCAL_E2E; process.env.NODE_ENV = 'test'; }],
  ])('fails closed %s', (_name, change) => {
    localE2E();
    const cookie = createE2ESessionCookie('owner');
    change();
    expect(isE2EAuthEnabled()).toBe(false);
    expect(matchesE2EAuthSecret('local-e2e-auth-secret-at-least-32-characters')).toBe(false);
    expect(readE2ESessionCookie(cookie)).toBeNull();
  });
});
