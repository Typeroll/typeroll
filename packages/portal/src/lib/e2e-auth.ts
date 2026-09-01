import { createHmac, timingSafeEqual } from 'node:crypto';
import type { AstroCookies } from 'astro';

export const E2E_SESSION_PERSONAS = {
  owner: { userId: 'typeroll-e2e-owner', email: 'owner@e2e.typeroll.local', orgId: 'e2e-core', displayName: 'E2E owner' },
  editor: { userId: 'typeroll-e2e-editor', email: 'editor@e2e.typeroll.local', orgId: 'e2e-core', displayName: 'E2E editor' },
  viewer: { userId: 'typeroll-e2e-viewer', email: 'viewer@e2e.typeroll.local', orgId: 'e2e-viewer', displayName: 'E2E viewer' },
  outsider: { userId: 'typeroll-e2e-outsider', email: 'outsider@e2e.typeroll.local', orgId: 'e2e-outsider', displayName: 'E2E outsider' },
  pending: { userId: 'typeroll-e2e-pending', email: 'pending@e2e.typeroll.local', orgId: undefined, displayName: 'E2E pending' },
} as const;

export type E2EPersonaId = keyof typeof E2E_SESSION_PERSONAS;

function secret(): string | null {
  const value = process.env.TYPEROLL_E2E_AUTH_SECRET;
  return value && value.length >= 32 ? value : null;
}

export function isE2EAuthEnabled(): boolean {
  const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT;
  return process.env.NODE_ENV === 'test' && !serviceAccount?.trim() && secret() !== null;
}

export function matchesE2EAuthSecret(supplied: string | null): boolean {
  const expected = secret();
  if (!isE2EAuthEnabled() || !expected || !supplied) return false;
  const expectedBuffer = Buffer.from(expected);
  const suppliedBuffer = Buffer.from(supplied);
  return suppliedBuffer.length === expectedBuffer.length && timingSafeEqual(suppliedBuffer, expectedBuffer);
}

function signature(persona: string, key: string): string {
  return createHmac('sha256', key).update(`typeroll-e2e-session:${persona}`).digest('base64url');
}

export function createE2ESessionCookie(persona: E2EPersonaId): string {
  const key = secret();
  if (!isE2EAuthEnabled() || !key) throw new Error('E2E authentication is disabled');
  return `e2e.${persona}.${signature(persona, key)}`;
}

export function readE2ESessionCookie(raw: string | undefined) {
  const key = secret();
  if (!raw || !isE2EAuthEnabled() || !key) return null;
  const [prefix, persona, supplied] = raw.split('.');
  if (prefix !== 'e2e' || !(persona in E2E_SESSION_PERSONAS) || !supplied) return null;
  const expected = Buffer.from(signature(persona, key));
  const actual = Buffer.from(supplied);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  return E2E_SESSION_PERSONAS[persona as E2EPersonaId];
}

export function setE2ESessionCookie(cookies: AstroCookies, persona: E2EPersonaId): void {
  cookies.set('typeroll_session', createE2ESessionCookie(persona), {
    httpOnly: true,
    secure: false,
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60,
  });
}
