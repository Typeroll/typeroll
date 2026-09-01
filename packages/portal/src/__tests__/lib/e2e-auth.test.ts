import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createE2ESessionCookie,
  E2E_SESSION_PERSONAS,
  isE2EAuthEnabled,
  matchesE2EAuthSecret,
  readE2ESessionCookie,
} from '../../lib/e2e-auth';

const previous = {
  nodeEnv: process.env.NODE_ENV,
  firebase: process.env.FIREBASE_SERVICE_ACCOUNT,
  firebaseProjectId: process.env.FIREBASE_PROJECT_ID,
  secret: process.env.TYPEROLL_E2E_AUTH_SECRET,
};

afterEach(() => {
  for (const [key, value] of [
    ['NODE_ENV', previous.nodeEnv],
    ['FIREBASE_SERVICE_ACCOUNT', previous.firebase],
    ['FIREBASE_PROJECT_ID', previous.firebaseProjectId],
    ['TYPEROLL_E2E_AUTH_SECRET', previous.secret],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
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

  it('accepts only a signed known persona in an isolated non-Firebase process', () => {
    process.env.NODE_ENV = 'test';
    process.env.FIREBASE_SERVICE_ACCOUNT = '';
    process.env.FIREBASE_PROJECT_ID = '';
    process.env.TYPEROLL_E2E_AUTH_SECRET = 'local-e2e-auth-secret-at-least-32-characters';
    const cookie = createE2ESessionCookie('editor');
    expect(isE2EAuthEnabled()).toBe(true);
    expect(matchesE2EAuthSecret('local-e2e-auth-secret-at-least-32-characters')).toBe(true);
    expect(matchesE2EAuthSecret('wrong-e2e-auth-secret-at-least-32-characters')).toBe(false);
    expect(readE2ESessionCookie(cookie)).toEqual(E2E_SESSION_PERSONAS.editor);
    expect(readE2ESessionCookie(cookie.replace('editor', 'owner'))).toBeNull();
    expect(readE2ESessionCookie('e2e.unknown.invalid')).toBeNull();
  });

  it('fails closed in production and whenever Firebase is configured', () => {
    process.env.TYPEROLL_E2E_AUTH_SECRET = 'local-e2e-auth-secret-at-least-32-characters';
    process.env.NODE_ENV = 'production';
    process.env.FIREBASE_SERVICE_ACCOUNT = '';
    process.env.FIREBASE_PROJECT_ID = '';
    expect(isE2EAuthEnabled()).toBe(false);
    delete process.env.NODE_ENV;
    expect(isE2EAuthEnabled()).toBe(false);
    process.env.NODE_ENV = 'test';
    process.env.FIREBASE_SERVICE_ACCOUNT = '{"project_id":"real"}';
    expect(isE2EAuthEnabled()).toBe(false);
    process.env.FIREBASE_SERVICE_ACCOUNT = '';
    process.env.FIREBASE_PROJECT_ID = 'real-project';
    expect(isE2EAuthEnabled()).toBe(false);
  });
});
