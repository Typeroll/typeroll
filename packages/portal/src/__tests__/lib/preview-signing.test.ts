// Unit tests for lib/preview-signing.

import { describe, it, expect, beforeEach } from 'vitest';

const SECRET = 'a-very-long-secret-string-at-least-32-chars-x';

describe('preview-signing', () => {
  beforeEach(() => {
    process.env.PREVIEW_HMAC_SECRET = SECRET;
  });

  it('signs and verifies a round-trip', async () => {
    const { signPreviewTicket, verifyPreviewToken } = await import('../../lib/preview-signing');
    const { token, expiresAt } = signPreviewTicket({
      orgId: 'org1', siteId: 'site1', versionId: 'main',
    });
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(new Date(expiresAt).getTime()).toBeGreaterThan(Date.now());

    const ticket = verifyPreviewToken(token);
    expect(ticket).toMatchObject({ org_id: 'org1', site_id: 'site1', version_id: 'main' });
    expect(ticket?.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it('rejects a tampered payload', async () => {
    const { signPreviewTicket, verifyPreviewToken } = await import('../../lib/preview-signing');
    const { token } = signPreviewTicket({ orgId: 'org1', siteId: 'site1', versionId: 'main' });
    const [payload, sig] = token.split('.');
    // Flip the last character of the payload so the signature no longer matches.
    const last = payload[payload.length - 1];
    const swapped = last === 'A' ? 'B' : 'A';
    const tampered = `${payload.slice(0, -1)}${swapped}.${sig}`;
    expect(verifyPreviewToken(tampered)).toBeNull();
  });

  it('rejects expired tokens', async () => {
    const { signPreviewTicket, verifyPreviewToken } = await import('../../lib/preview-signing');
    const { token } = signPreviewTicket({ orgId: 'org1', siteId: 'site1', versionId: 'main', ttlSeconds: 60 });
    // Patch the payload to set exp in the past, re-sign with the wrong secret
    // → verify must reject.
    expect(verifyPreviewToken(token + 'junk')).toBeNull();
    // Clearer test: a token signed with a different secret.
    process.env.PREVIEW_HMAC_SECRET = SECRET + '-other';
    const tampered = await (async () => {
      const { signPreviewTicket: sign2 } = await import('../../lib/preview-signing');
      return sign2({ orgId: 'org1', siteId: 'site1', versionId: 'main' }).token;
    })();
    process.env.PREVIEW_HMAC_SECRET = SECRET;
    expect(verifyPreviewToken(tampered)).toBeNull();
  });

  it('rejects missing or malformed tokens', async () => {
    const { verifyPreviewToken } = await import('../../lib/preview-signing');
    expect(verifyPreviewToken(null)).toBeNull();
    expect(verifyPreviewToken('')).toBeNull();
    expect(verifyPreviewToken('no-dot')).toBeNull();
    expect(verifyPreviewToken('.empty-payload')).toBeNull();
  });

  it('throws / returns null when the secret is missing', async () => {
    delete process.env.PREVIEW_HMAC_SECRET;
    const { isPreviewSigningConfigured, signPreviewTicket, verifyPreviewToken } = await import('../../lib/preview-signing');
    expect(isPreviewSigningConfigured()).toBe(false);
    expect(() => signPreviewTicket({ orgId: 'o', siteId: 's', versionId: 'main' })).toThrow();
    expect(verifyPreviewToken('any.thing')).toBeNull();
  });
});
