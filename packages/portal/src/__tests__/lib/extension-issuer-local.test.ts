// The Worker bundle fixes NODE_ENV to production, also in `wrangler dev`.
// A loopback portal must still publish its Extension issuer (with a
// per-isolate key, as development does); a deployed origin must not.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { extensionIssuer, extensionJwks } from '../../lib/extensions/auth';

afterEach(() => { vi.unstubAllEnvs(); });

describe('Extension issuer under the production Worker build', () => {
  it('serves a loopback portal without a configured signing key', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('EXTENSION_SIGNING_PRIVATE_JWK', '');
    vi.stubEnv('PORTAL_PUBLIC_URL', 'http://127.0.0.1:4322');
    expect(extensionIssuer()).toBe('http://127.0.0.1:4322');
    expect(extensionJwks().keys[0]).toMatchObject({ kty: 'EC', crv: 'P-256' });
  });

  it('still requires HTTPS and a signing key on any other origin', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('EXTENSION_SIGNING_PRIVATE_JWK', '');
    vi.stubEnv('PORTAL_PUBLIC_URL', 'http://cms.example.test');
    expect(() => extensionIssuer()).toThrow(/canonical origin/);
    vi.stubEnv('PORTAL_PUBLIC_URL', 'https://cms.example.test');
    expect(extensionIssuer()).toBe('https://cms.example.test');
    expect(() => extensionJwks()).toThrow(/EXTENSION_SIGNING_PRIVATE_JWK is required/);
    vi.stubEnv('PORTAL_PUBLIC_URL', 'http://127.0.0.1.example.test');
    expect(() => extensionIssuer()).toThrow(/canonical origin/);
  });
});
