// The Worker bundle fixes NODE_ENV to production, also on a local Worker.
// Local relaxations therefore key off the portal's loopback origin.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isLoopbackUrl, portalCookiesSecure } from '../../lib/local-e2e';
import { selectOrganization } from '../../lib/organization-session';

afterEach(() => { vi.unstubAllEnvs(); });

describe('loopback portal', () => {
  it('recognizes only loopback hosts', () => {
    for (const url of ['http://127.0.0.1:4322', 'http://localhost:8799/', 'https://localhost', 'http://[::1]:4322']) expect(isLoopbackUrl(url), url).toBe(true);
    for (const url of ['https://app.typeroll.com', 'http://127.0.0.1.example.test', 'http://localhost.example.test', 'file:///tmp', 'not a url', '', undefined]) expect(isLoopbackUrl(url), String(url)).toBe(false);
  });

  it('keeps portal cookies Secure in production except on a plain-http loopback portal', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('PORTAL_PUBLIC_URL', 'https://app.typeroll.com');
    expect(portalCookiesSecure()).toBe(true);
    vi.stubEnv('PORTAL_PUBLIC_URL', '');
    expect(portalCookiesSecure()).toBe(true);
    vi.stubEnv('PORTAL_PUBLIC_URL', 'https://localhost:8443');
    expect(portalCookiesSecure()).toBe(true);
    vi.stubEnv('PORTAL_PUBLIC_URL', 'http://127.0.0.1:4322');
    expect(portalCookiesSecure()).toBe(false);
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('PORTAL_PUBLIC_URL', 'https://app.typeroll.com');
    expect(portalCookiesSecure()).toBe(false);
  });

  it('sets the organization selection cookie so a local Worker\'s clients keep it', () => {
    const set = vi.fn();
    const cookies = { set, delete: vi.fn() } as never;
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('PORTAL_PUBLIC_URL', 'http://127.0.0.1:4322');
    selectOrganization(cookies, 'user', 'org');
    expect(set.mock.calls[0]?.[2]).toMatchObject({ secure: false, httpOnly: true });
    vi.stubEnv('PORTAL_PUBLIC_URL', 'https://app.typeroll.com');
    selectOrganization(cookies, 'user', 'org');
    expect(set.mock.calls[1]?.[2]).toMatchObject({ secure: true, httpOnly: true });
  });
});
