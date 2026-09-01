import { beforeEach, describe, expect, it, vi } from 'vitest';

const { app, applicationDefault, cert, getApps, initializeApp } = vi.hoisted(() => {
  const app = { name: '[DEFAULT]' };
  return {
    app,
    applicationDefault: vi.fn(() => ({ mode: 'adc' })),
    cert: vi.fn((credentials) => ({ mode: 'json', credentials })),
    getApps: vi.fn((): unknown[] => []),
    initializeApp: vi.fn(() => app),
  };
});

vi.mock('firebase-admin/app', () => ({
  applicationDefault,
  cert,
  getApps,
  initializeApp,
}));

describe('Firebase Admin configuration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getApps.mockReturnValue([]);
  });

  it('uses Application Default Credentials for the Cloud Run profile', async () => {
    const { getFirebaseAdminApp, isFirebaseAdminConfigured } = await import('../../lib/firebase-admin');
    const env = { FIREBASE_PROJECT_ID: 'customer-project' };

    expect(isFirebaseAdminConfigured(env)).toBe(true);
    await expect(getFirebaseAdminApp(env)).resolves.toBe(app);
    expect(applicationDefault).toHaveBeenCalledOnce();
    expect(initializeApp).toHaveBeenCalledWith({
      credential: { mode: 'adc' },
      projectId: 'customer-project',
    });
    expect(cert).not.toHaveBeenCalled();
  });

  it('retains service-account JSON for portable deployments', async () => {
    const { getFirebaseAdminApp } = await import('../../lib/firebase-admin');
    const credentials = { project_id: 'portable-project', client_email: 'test@example.invalid' };

    await getFirebaseAdminApp({ FIREBASE_SERVICE_ACCOUNT: JSON.stringify(credentials) });

    expect(cert).toHaveBeenCalledWith(credentials);
    expect(initializeApp).toHaveBeenCalledWith({
      credential: { mode: 'json', credentials },
      projectId: 'portable-project',
    });
    expect(applicationDefault).not.toHaveBeenCalled();
  });

  it('rejects conflicting explicit and JSON project IDs', async () => {
    const { getFirebaseAdminApp } = await import('../../lib/firebase-admin');

    await expect(getFirebaseAdminApp({
      FIREBASE_PROJECT_ID: 'customer-project',
      FIREBASE_SERVICE_ACCOUNT: JSON.stringify({ project_id: 'other-project' }),
    })).rejects.toThrow('must match');
    expect(initializeApp).not.toHaveBeenCalled();
  });

  it('reuses an existing Admin app without resolving credentials again', async () => {
    const { getFirebaseAdminApp } = await import('../../lib/firebase-admin');
    getApps.mockReturnValue([app]);

    await expect(getFirebaseAdminApp({})).resolves.toBe(app);
    expect(applicationDefault).not.toHaveBeenCalled();
    expect(cert).not.toHaveBeenCalled();
    expect(initializeApp).not.toHaveBeenCalled();
  });
});
