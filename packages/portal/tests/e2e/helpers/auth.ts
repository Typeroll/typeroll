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

export async function authenticatePersona(page: Page, persona: CorePersona): Promise<void> {
  const target = process.env.TYPEROLL_E2E_TARGET ?? 'local';
  const portalOrigin = process.env.TYPEROLL_E2E_PORTAL_URL ?? 'http://127.0.0.1:4322';
  if (target === 'local') {
    const response = await page.request.post('/api/auth/e2e-session', {
      headers: {
        Origin: portalOrigin,
        'x-typeroll-e2e-secret': required('TYPEROLL_E2E_AUTH_SECRET'),
      },
      data: { persona },
    });
    if (!response.ok()) throw new Error(`Local E2E session exchange failed with ${response.status()}`);
    return;
  }

  const { email, password } = personaCredentials(persona);
  const apiKey = required('TYPEROLL_E2E_FIREBASE_API_KEY');
  const tokenResponse = await page.request.post(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(apiKey)}`,
    { data: { email, password, returnSecureToken: true } },
  );
  if (!tokenResponse.ok()) throw new Error(`Firebase E2E login failed with ${tokenResponse.status()}`);
  const token = await tokenResponse.json() as { idToken?: string };
  if (!token.idToken) throw new Error('Firebase E2E login returned no ID token');
  const sessionResponse = await page.request.post('/api/auth/session', {
    headers: { Origin: portalOrigin },
    data: { idToken: token.idToken },
  });
  if (!sessionResponse.ok()) throw new Error(`Portal E2E session exchange failed with ${sessionResponse.status()}`);
}
