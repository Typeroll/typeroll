import type { Page } from '@playwright/test';

export type CorePersona = 'owner' | 'editor' | 'viewer' | 'outsider' | 'pending';

const CREDENTIAL_KEYS: Record<CorePersona, { email: string; password: string }> = {
  owner: { email: 'TYPEROLL_E2E_OWNER_EMAIL', password: 'TYPEROLL_E2E_OWNER_PASSWORD' },
  editor: { email: 'TYPEROLL_E2E_EDITOR_EMAIL', password: 'TYPEROLL_E2E_EDITOR_PASSWORD' },
  viewer: { email: 'TYPEROLL_E2E_VIEWER_EMAIL', password: 'TYPEROLL_E2E_VIEWER_PASSWORD' },
  outsider: { email: 'TYPEROLL_E2E_OUTSIDER_EMAIL', password: 'TYPEROLL_E2E_OUTSIDER_PASSWORD' },
  pending: { email: 'TYPEROLL_E2E_PENDING_EMAIL', password: 'TYPEROLL_E2E_PENDING_PASSWORD' },
};

function required(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`${key} is required for remote E2E authentication`);
  return value;
}

export function personaCredentials(persona: CorePersona) {
  const keys = CREDENTIAL_KEYS[persona];
  return { email: required(keys.email), password: required(keys.password) };
}

export interface AuthenticateOptions {
  /** false creates the same persona with an unconfirmed email address
   *  ("Check your email" state). Local E2E sessions only. */
  emailVerified?: boolean;
}

export async function authenticatePersona(page: Page, persona: CorePersona, { emailVerified = true }: AuthenticateOptions = {}): Promise<void> {
  const target = process.env.TYPEROLL_E2E_TARGET ?? 'local';
  const portalOrigin = process.env.TYPEROLL_E2E_PORTAL_URL ?? 'http://127.0.0.1:4322';
  if (target === 'local') {
    const response = await page.request.post('/api/auth/e2e-session', {
      headers: {
        Origin: portalOrigin,
        'x-typeroll-e2e-secret': required('TYPEROLL_E2E_AUTH_SECRET'),
      },
      data: emailVerified ? { persona } : { persona, emailVerified: false },
    });
    if (!response.ok()) throw new Error(`Local E2E session exchange failed with ${response.status()}`);
    return;
  }
  // Remote personas are provisioned with confirmed addresses.
  if (!emailVerified) throw new Error('Unconfirmed-email sessions are only available against the local E2E server');

  // Remote targets sign in with the persona's real password through the
  // portal's account sign-in (Better Auth); the session cookie lands in the
  // page's browser context.
  const { email, password } = personaCredentials(persona);
  const response = await page.request.post('/api/auth/sign-in/email', {
    headers: { Origin: portalOrigin },
    data: { email, password },
  });
  if (!response.ok()) throw new Error(`Remote E2E password sign-in failed with ${response.status()}`);
}
