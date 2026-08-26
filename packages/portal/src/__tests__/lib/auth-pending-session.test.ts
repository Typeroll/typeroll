import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock firebase-admin modules so the test doesn't need real Firebase credentials.
vi.mock('firebase-admin/auth', () => ({
  getAuth: vi.fn(() => ({
    verifySessionCookie: vi.fn(),
    createSessionCookie: vi.fn(),
    verifyIdToken: vi.fn(),
  })),
}));
vi.mock('firebase-admin/app', () => ({
  initializeApp: vi.fn(),
  cert: vi.fn(),
  getApps: vi.fn(() => []),
}));

describe('auth: pending session (no org_id claim)', () => {
  beforeEach(() => {
    vi.resetModules();
    // Simulate Firebase being configured so the real code path runs.
    process.env.FIREBASE_SERVICE_ACCOUNT = JSON.stringify({ project_id: 'test', type: 'service_account' });
  });

  it('setSessionFromIdToken returns orgId=undefined when the claim is missing', async () => {
    const { getAuth } = await import('firebase-admin/auth');
    const mockAuth = {
      createSessionCookie: vi.fn().mockResolvedValue('mock-cookie'),
      verifyIdToken: vi.fn().mockResolvedValue({
        uid: 'user-1',
        email: 'new@example.com',
        name: 'New User',
        // Deliberately no org_id claim
      }),
    };
    (getAuth as ReturnType<typeof vi.fn>).mockReturnValue(mockAuth);

    const mockCookies = {
      set: vi.fn(),
      get: vi.fn(),
    } as any;

    const { setSessionFromIdToken } = await import('../../lib/auth');
    const session = await setSessionFromIdToken(mockCookies, 'fake-id-token');

    expect(session.userId).toBe('user-1');
    expect(session.email).toBe('new@example.com');
    expect(session.orgId).toBeUndefined();
    // Cookie must still be set even for pending sessions.
    expect(mockCookies.set).toHaveBeenCalled();
  });

  it('setSessionFromIdToken returns orgId when the claim is present', async () => {
    const { getAuth } = await import('firebase-admin/auth');
    const mockAuth = {
      createSessionCookie: vi.fn().mockResolvedValue('mock-cookie'),
      verifyIdToken: vi.fn().mockResolvedValue({
        uid: 'user-2',
        email: 'member@example.com',
        name: 'Member',
        org_id: 'acme-corp',
      }),
    };
    (getAuth as ReturnType<typeof vi.fn>).mockReturnValue(mockAuth);

    const mockCookies = { set: vi.fn(), get: vi.fn() } as any;
    const { setSessionFromIdToken } = await import('../../lib/auth');
    const session = await setSessionFromIdToken(mockCookies, 'fake-id-token');

    expect(session.orgId).toBe('acme-corp');
  });

  it('getSession returns session with orgId=undefined when cookie is valid but claim is missing', async () => {
    const { getAuth } = await import('firebase-admin/auth');
    const mockAuth = {
      verifySessionCookie: vi.fn().mockResolvedValue({
        uid: 'user-3',
        email: 'pending@example.com',
        // No org_id claim
      }),
    };
    (getAuth as ReturnType<typeof vi.fn>).mockReturnValue(mockAuth);

    const mockCookies = {
      get: vi.fn((name: string) => {
        if (name === 'typeroll_session') return { value: 'valid-session-cookie' };
        return undefined;
      }),
    } as any;

    const { getSession } = await import('../../lib/auth');
    const session = await getSession(mockCookies);

    expect(session).not.toBeNull();
    expect(session!.orgId).toBeUndefined();
    expect(session!.userId).toBe('user-3');
  });

  it('getSession returns null when cookie verification fails', async () => {
    const { getAuth } = await import('firebase-admin/auth');
    const mockAuth = {
      verifySessionCookie: vi.fn().mockRejectedValue(new Error('Token expired')),
    };
    (getAuth as ReturnType<typeof vi.fn>).mockReturnValue(mockAuth);

    const mockCookies = {
      get: vi.fn((name: string) => {
        if (name === 'typeroll_session') return { value: 'bad-cookie' };
        return undefined;
      }),
    } as any;

    const { getSession } = await import('../../lib/auth');
    const session = await getSession(mockCookies);

    expect(session).toBeNull();
  });
});

describe('isPendingSession', () => {
  it('returns true when orgId is undefined', async () => {
    const { isPendingSession } = await import('../../lib/auth');
    expect(isPendingSession({ userId: 'u', email: 'e@e.com', orgId: undefined })).toBe(true);
  });

  it('returns false when orgId is set', async () => {
    const { isPendingSession } = await import('../../lib/auth');
    expect(isPendingSession({ userId: 'u', email: 'e@e.com', orgId: 'my-org' })).toBe(false);
  });
});
