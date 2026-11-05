import { afterEach, describe, expect, it, vi } from 'vitest';

function cookiesWith(value?: string) {
  return {
    get: vi.fn(() => value === undefined ? undefined : { value }),
    set: vi.fn(),
    delete: vi.fn(),
  } as any;
}

afterEach(() => {
  vi.unstubAllEnvs();
  delete process.env.FIREBASE_SERVICE_ACCOUNT;
  delete process.env.FIREBASE_PROJECT_ID;
  vi.resetModules();
});

describe('development authentication', () => {
  it('provides the built-in user outside production when accounts are not configured', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    delete process.env.FIREBASE_SERVICE_ACCOUNT;
    delete process.env.FIREBASE_PROJECT_ID;

    const { getSession, isDevAuthEnabled } = await import('../../lib/auth');

    expect(isDevAuthEnabled()).toBe(true);
    expect(await getSession(cookiesWith())).toMatchObject({
      userId: 'dev-user',
      email: 'dev@typeroll.local',
      orgId: 'default',
    });
  });

  it('disables development auth when accounts are configured', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('AUTH_SECRET', 'real-auth-secret-0123456789abcdef-0123456789');

    const { isDevAuthEnabled } = await import('../../lib/auth');

    expect(isDevAuthEnabled()).toBe(false);
  });

  it('fails closed in production when accounts are not configured', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    delete process.env.FIREBASE_SERVICE_ACCOUNT;

    const { getSession, isDevAuthEnabled } = await import('../../lib/auth');

    expect(isDevAuthEnabled()).toBe(false);
    expect(await getSession(cookiesWith())).toBeNull();
    expect(await getSession(cookiesWith('dev'))).toBeNull();
  });

  it('rejects the dev-session endpoint in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    delete process.env.FIREBASE_SERVICE_ACCOUNT;

    const { POST } = await import('../../pages/api/auth/dev-session');
    const response = await POST({
      cookies: cookiesWith(),
      redirect: vi.fn(),
    } as any);

    expect(response.status).toBe(403);
  });
});
