import crypto from 'node:crypto';
import { describe, it, expect, beforeAll } from 'vitest';
import { signFormToken, verifyFormToken } from '../../lib/forms-signing';

beforeAll(() => {
  process.env.FORMS_HMAC_SECRET = 'test-hmac-secret-please-change-for-real-use-32+chars';
});

describe('form HMAC tokens', () => {
  it('verifies a freshly-signed token', () => {
    const token = signFormToken('org', 'site', 'form');
    const v = verifyFormToken(token);
    expect(v).toEqual({ orgId: 'org', siteId: 'site', formId: 'form' });
  });

  it('rejects malformed input', () => {
    expect(verifyFormToken('')).toBeNull();
    expect(verifyFormToken('not-a-token')).toBeNull();
    expect(verifyFormToken('a|b|c')).toBeNull();
  });

  it('rejects a tampered payload', () => {
    const token = signFormToken('org', 'site', 'form');
    // Change the orgId without re-signing.
    const parts = token.split('|');
    parts[0] = 'evilorg';
    expect(verifyFormToken(parts.join('|'))).toBeNull();
  });

  it('rejects a token signed with a different secret', () => {
    const token = signFormToken('org', 'site', 'form');
    process.env.FORMS_HMAC_SECRET = 'something-else-32-chars-long-pad-pad-pad';
    expect(verifyFormToken(token)).toBeNull();
    process.env.FORMS_HMAC_SECRET = 'test-hmac-secret-please-change-for-real-use-32+chars';
  });
});

describe('form token domain separation', () => {
  it('never accepts an analytics event token as a form token', async () => {
    const { signAnalyticsEventToken } = await import('../../lib/apps/analytics-events');
    expect(verifyFormToken(signAnalyticsEventToken('org', 'site'))).toBeNull();
    // The legacy analytics format signed `analytics-v1.org.site` with the
    // secret itself, the exact payload of a form token for org "analytics-v1".
    const legacyPayload = 'analytics-v1.org.site';
    const legacy = `${legacyPayload}.${crypto.createHmac('sha256', process.env.FORMS_HMAC_SECRET!).update(legacyPayload).digest('base64url')}`;
    expect(verifyFormToken(legacy)).toBeNull();
  });

  it('mints no form token for the reserved organization id', async () => {
    const { formEmbedInfo } = await import('../../lib/forms-signing');
    expect(() => signFormToken('analytics-v1', 'org', 'site')).toThrow();
    expect(formEmbedInfo('analytics-v1', 'org', 'site').submit_token).toBeNull();
  });

  it('accepts current analytics tokens and legacy ones, but not a form token', async () => {
    const { signAnalyticsEventToken, verifyAnalyticsEventToken } = await import('../../lib/apps/analytics-events');
    const current = signAnalyticsEventToken('org', 'site');
    expect(current.startsWith('analytics-v2.')).toBe(true);
    expect(verifyAnalyticsEventToken(current)).toEqual({ orgId: 'org', siteId: 'site' });
    const legacyPayload = 'analytics-v1.org.site';
    const legacy = `${legacyPayload}.${crypto.createHmac('sha256', process.env.FORMS_HMAC_SECRET!).update(legacyPayload).digest('base64url')}`;
    expect(verifyAnalyticsEventToken(legacy)).toEqual({ orgId: 'org', siteId: 'site' });
    // A form token for org "analytics-v2" carries the same text shape.
    const formShaped = `analytics-v2.org.site.${crypto.createHmac('sha256', process.env.FORMS_HMAC_SECRET!).update('analytics-v2.org.site').digest('base64url')}`;
    expect(verifyAnalyticsEventToken(formShaped)).toBeNull();
  });
});

describe('single-use proof of work', () => {
  function solve(token: string, bits: number): string {
    const bucket = Math.floor(Date.now() / 600_000);
    for (let nonce = 0; ; nonce++) {
      const digest = crypto.createHash('sha256').update(`${token}.${bucket}.${nonce}`).digest();
      let zeros = 0;
      for (const byte of digest) { if (byte === 0) { zeros += 8; continue; } zeros += Math.clz32(byte) - 24; break; }
      if (zeros >= bits) return `${bucket}.${nonce}`;
    }
  }

  it('accepts a valid proof for repeated posts and rejects garbage', async () => {
    const { verifyPow } = await import('../../lib/forms-signing');
    const token = signFormToken('org', 'site', 'form');
    const pow = solve(token, 8);
    expect(verifyPow(token, pow, 8)).toBe(true);
    expect(verifyPow(token, pow, 8)).toBe(true);
    expect(verifyPow(token, 'garbage', 8)).toBe(false);
  });

});
