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
