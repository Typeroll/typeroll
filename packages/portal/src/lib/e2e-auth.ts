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

/** Local E2E sessions have a confirmed email unless a spec explicitly asks
 * for the "Check your email" state of the same persona. */
export interface E2ESessionOptions { emailVerified?: boolean }

const UNVERIFIED = 'unverified';

function secret(): string | null {
  const value = process.env.TYPEROLL_E2E_AUTH_SECRET;
  return value && value.length >= 32 ? value : null;
}

export function isE2EAuthEnabled(): boolean {
  const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT;
  const projectId = process.env.FIREBASE_PROJECT_ID;
  return process.env.NODE_ENV === 'test' && !serviceAccount?.trim() && !projectId?.trim() && secret() !== null;
}

export function matchesE2EAuthSecret(supplied: string | null): boolean {
  const expected = secret();
  if (!isE2EAuthEnabled() || !expected || !supplied) return false;
  const expectedBuffer = Buffer.from(expected);
  const suppliedBuffer = Buffer.from(supplied);
  return suppliedBuffer.length === expectedBuffer.length && timingSafeEqual(suppliedBuffer, expectedBuffer);
}

function signature(persona: string, key: string, emailVerified: boolean): string {
  // Confirmed sessions keep the original signed payload; the unconfirmed
  // variant signs a distinct value so one cannot be turned into the other.
  const payload = emailVerified ? `typeroll-e2e-session:${persona}` : `typeroll-e2e-session:${persona}:${UNVERIFIED}`;
  return createHmac('sha256', key).update(payload).digest('base64url');
}

export function createE2ESessionCookie(persona: E2EPersonaId, { emailVerified = true }: E2ESessionOptions = {}): string {
  const key = secret();
  if (!isE2EAuthEnabled() || !key) throw new Error('E2E authentication is disabled');
  return emailVerified
    ? `e2e.${persona}.${signature(persona, key, true)}`
    : `e2e.${persona}.${UNVERIFIED}.${signature(persona, key, false)}`;
}

export function readE2ESessionCookie(raw: string | undefined) {
  const key = secret();
  if (!raw || !isE2EAuthEnabled() || !key) return null;
  const parts = raw.split('.');
  const emailVerified = parts.length === 3;
  if (!emailVerified && (parts.length !== 4 || parts[2] !== UNVERIFIED)) return null;
  const [prefix, persona] = parts;
  const supplied = parts[parts.length - 1];
  if (prefix !== 'e2e' || !(persona in E2E_SESSION_PERSONAS) || !supplied) return null;
  const expected = Buffer.from(signature(persona, key, emailVerified));
  const actual = Buffer.from(supplied);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  return { ...E2E_SESSION_PERSONAS[persona as E2EPersonaId], emailVerified };
}

export function setE2ESessionCookie(cookies: AstroCookies, persona: E2EPersonaId, options: E2ESessionOptions = {}): void {
  cookies.set('typeroll_session', createE2ESessionCookie(persona, options), {
    httpOnly: true,
    secure: false,
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60,
  });
}
